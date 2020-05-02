import { AbstractHistogramBase } from "./AbstractHistogramBase";
import RecordedValuesIterator from "./RecordedValuesIterator";
import PercentileIterator from "./PercentileIterator";

import ulp from "./ulp";
import { FloatFormatter, IntegerFormatter } from "./formatters";

export default class Histogram<T, U> extends AbstractHistogramBase<T, U> {
  // "Hot" accessed fields (used in the the value recording code path) are bunched here, such
  // that they will have a good chance of ending up in the same cache line as the totalCounts and
  // counts array reference fields that subclass implementations will typically add.

  /**
   * Number of leading zeros in the largest value that can fit in bucket 0.
   */
  leadingZeroCountBase: i32;
  subBucketHalfCountMagnitude: i32;
  /**
   * Largest k such that 2^k &lt;= lowestDiscernibleValue
   */
  unitMagnitude: i32;
  subBucketHalfCount: i32;

  lowestDiscernibleValueRounded: u64;

  /**
   * Biggest value that can fit in bucket 0
   */
  subBucketMask: u64;
  /**
   * Lowest unitMagnitude bits are set
   */
  unitMagnitudeMask: u64;

  maxValue: u64 = 0;
  minNonZeroValue: u64 = U64.MAX_VALUE;

  counts: T;
  totalCount: u64 = 0;

  constructor(
    lowestDiscernibleValue: u64,
    highestTrackableValue: u64,
    numberOfSignificantValueDigits: u8
  ) {
    super();
    // Verify argument validity
    if (lowestDiscernibleValue < 1) {
      throw new Error("lowestDiscernibleValue must be >= 1");
    }
    if (highestTrackableValue < 2 * lowestDiscernibleValue) {
      throw new Error(
        `highestTrackableValue must be >= 2 * lowestDiscernibleValue ( 2 * ${lowestDiscernibleValue} )`
      );
    }
    if (
      numberOfSignificantValueDigits < 0 ||
      numberOfSignificantValueDigits > 5
    ) {
      throw new Error("numberOfSignificantValueDigits must be between 0 and 5");
    }
    this.identity = AbstractHistogramBase.identityBuilder++;

    this.init(
      lowestDiscernibleValue,
      highestTrackableValue,
      numberOfSignificantValueDigits,
      1.0
    );
  }

  init(
    lowestDiscernibleValue: u64,
    highestTrackableValue: u64,
    numberOfSignificantValueDigits: u8,
    integerToDoubleValueConversionRatio: f64
  ): void {
    this.lowestDiscernibleValue = lowestDiscernibleValue;
    this.highestTrackableValue = highestTrackableValue;
    this.numberOfSignificantValueDigits = numberOfSignificantValueDigits;
    this.integerToDoubleValueConversionRatio = integerToDoubleValueConversionRatio;

    /*
     * Given a 3 decimal point accuracy, the expectation is obviously for "+/- 1 unit at 1000". It also means that
     * it's "ok to be +/- 2 units at 2000". The "tricky" thing is that it is NOT ok to be +/- 2 units at 1999. Only
     * starting at 2000. So internally, we need to maintain single unit resolution to 2x 10^decimalPoints.
     */
    const largestValueWithSingleUnitResolution =
      2 * <u64>Math.pow(10, numberOfSignificantValueDigits);

    this.unitMagnitude = <i32>floor(Math.log2(<f64>lowestDiscernibleValue));

    //this.lowestDiscernibleValueRounded = pow(2, this.unitMagnitude);
    this.unitMagnitudeMask = (1 << this.unitMagnitude) - 1;

    // We need to maintain power-of-two subBucketCount (for clean direct indexing) that is large enough to
    // provide unit resolution to at least largestValueWithSingleUnitResolution. So figure out
    // largestValueWithSingleUnitResolution's nearest power-of-two (rounded up), and use that:
    const subBucketCountMagnitude = <i32>(
      ceil(Math.log2(<f64>largestValueWithSingleUnitResolution))
    );
    this.subBucketHalfCountMagnitude = subBucketCountMagnitude - 1;
    this.subBucketCount = 1 << subBucketCountMagnitude;
    this.subBucketHalfCount = this.subBucketCount >> 1;
    this.subBucketMask = (<u64>this.subBucketCount - 1) << this.unitMagnitude;

    this.establishSize(highestTrackableValue);
    this.counts = instantiate<T>(this.countsArrayLength);

    this.leadingZeroCountBase =
      53 - this.unitMagnitude - this.subBucketHalfCountMagnitude - 1;
    this.percentileIterator = new PercentileIterator(this, 1);
    this.recordedValuesIterator = new RecordedValuesIterator(this);
  }

  /**
   * The buckets (each of which has subBucketCount sub-buckets, here assumed to be 2048 as an example) overlap:
   *
   * <pre>
   * The 0'th bucket covers from 0...2047 in multiples of 1, using all 2048 sub-buckets
   * The 1'th bucket covers from 2048..4097 in multiples of 2, using only the top 1024 sub-buckets
   * The 2'th bucket covers from 4096..8191 in multiple of 4, using only the top 1024 sub-buckets
   * ...
   * </pre>
   *
   * Bucket 0 is "special" here. It is the only one that has 2048 entries. All the rest have 1024 entries (because
   * their bottom half overlaps with and is already covered by the all of the previous buckets put together). In other
   * words, the k'th bucket could represent 0 * 2^k to 2048 * 2^k in 2048 buckets with 2^k precision, but the midpoint
   * of 1024 * 2^k = 2048 * 2^(k-1) = the k-1'th bucket's end, so we would use the previous bucket for those lower
   * values as it has better precision.
   */
  establishSize(newHighestTrackableValue: u64): void {
    // establish counts array length:
    this.countsArrayLength = this.determineArrayLengthNeeded(
      newHighestTrackableValue
    );
    // establish exponent range needed to support the trackable value with no overflow:
    this.bucketCount = this.getBucketsNeededToCoverValue(
      newHighestTrackableValue
    );
    // establish the new highest trackable value:
    this.highestTrackableValue = newHighestTrackableValue;
  }

  determineArrayLengthNeeded(highestTrackableValue: u64): i32 {
    if (highestTrackableValue < 2 * this.lowestDiscernibleValue) {
      throw new Error(
        "highestTrackableValue cannot be < (2 * lowestDiscernibleValue)"
      );
    }
    //determine counts array length needed:
    const countsArrayLength = this.getLengthForNumberOfBuckets(
      this.getBucketsNeededToCoverValue(highestTrackableValue)
    );
    return countsArrayLength;
  }

  /**
   * If we have N such that subBucketCount * 2^N > max value, we need storage for N+1 buckets, each with enough
   * slots to hold the top half of the subBucketCount (the lower half is covered by previous buckets), and the +1
   * being used for the lower half of the 0'th bucket. Or, equivalently, we need 1 more bucket to capture the max
   * value if we consider the sub-bucket length to be halved.
   */
  getLengthForNumberOfBuckets(numberOfBuckets: i32): i32 {
    const lengthNeeded: i32 =
      (numberOfBuckets + 1) * (this.subBucketCount >> 1);
    return lengthNeeded;
  }

  getBucketsNeededToCoverValue(value: u64): i32 {
    // the k'th bucket can express from 0 * 2^k to subBucketCount * 2^k in units of 2^k
    let smallestUntrackableValue =
      (<u64>this.subBucketCount) << this.unitMagnitude;
    // always have at least 1 bucket
    let bucketsNeeded = 1;
    while (smallestUntrackableValue <= value) {
      if (smallestUntrackableValue > u64.MAX_VALUE >> 1) {
        // next shift will overflow, meaning that bucket could represent values up to ones greater than
        // Number.MAX_SAFE_INTEGER, so it's the last bucket
        return bucketsNeeded + 1;
      }
      smallestUntrackableValue = smallestUntrackableValue << 1;
      bucketsNeeded++;
    }
    return bucketsNeeded;
  }

  /**
   * Record a value in the histogram
   *
   * @param value The value to be recorded
   * @throws may throw Error if value is exceeds highestTrackableValue
   */
  recordValue(value: u64): void {
    this.recordSingleValue(value);
  }

  recordSingleValue(value: u64): void {
    const countsIndex = this.countsArrayIndex(value);
    //log<string>("recordSingleValue");
    //log<u64>(value);
    //log<i32>(countsIndex);
    if (countsIndex >= this.countsArrayLength) {
      // @ts-ignore
      this.handleRecordException(<U>1, value);
    } else {
      this.incrementCountAtIndex(countsIndex);
    }
    this.updateMinAndMax(value);
    this.incrementTotalCount();
  }

  handleRecordException(count: u64, value: u64): void {
    if (!this.autoResize) {
      throw new Error(
        "Value " + value.toString() + " is outside of histogram covered range"
      );
    }
    this.resize(value);
    const countsIndex: i32 = this.countsArrayIndex(value);
    this.addToCountAtIndex(countsIndex, count);
    this.highestTrackableValue = this.highestEquivalentValue(
      this.valueFromIndex(this.countsArrayLength - 1)
    );
  }

  countsArrayIndex(value: u64): i32 {
    if (value < 0) {
      throw new Error("Histogram recorded value cannot be negative.");
    }
    const bucketIndex = this.getBucketIndex(value);
    const subBucketIndex = this.getSubBucketIndex(value, bucketIndex);
    return this.computeCountsArrayIndex(bucketIndex, subBucketIndex);
  }

  private computeCountsArrayIndex(bucketIndex: i32, subBucketIndex: i32): i32 {
    assert(subBucketIndex < this.subBucketCount);
    assert(bucketIndex == 0 || subBucketIndex >= this.subBucketHalfCount);

    // Calculate the index for the first entry that will be used in the bucket (halfway through subBucketCount).
    // For bucketIndex 0, all subBucketCount entries may be used, but bucketBaseIndex is still set in the middle.
    const bucketBaseIndex =
      (bucketIndex + 1) * (1 << this.subBucketHalfCountMagnitude);
    // Calculate the offset in the bucket. This subtraction will result in a positive value in all buckets except
    // the 0th bucket (since a value in that bucket may be less than half the bucket's 0 to subBucketCount range).
    // However, this works out since we give bucket 0 twice as much space.
    const offsetInBucket = subBucketIndex - this.subBucketHalfCount;
    // The following is the equivalent of ((subBucketIndex  - subBucketHalfCount) + bucketBaseIndex;
    return bucketBaseIndex + offsetInBucket;
  }

  /**
   * @return the lowest (and therefore highest precision) bucket index that can represent the value
   */
  getBucketIndex(value: u64): i32 {
    // Calculates the number of powers of two by which the value is greater than the biggest value that fits in
    // bucket 0. This is the bucket index since each successive bucket can hold a value 2x greater.
    // The mask maps small values to bucket 0.

    // return this.leadingZeroCountBase - Long.numberOfLeadingZeros(value | subBucketMask);
    return <i32>(
      max(
        floor(Math.log2(<f64>value)) -
          this.subBucketHalfCountMagnitude -
          this.unitMagnitude,
        0
      )
    );
    return 0;
  }

  getSubBucketIndex(value: u64, bucketIndex: i32): i32 {
    // For bucketIndex 0, this is just value, so it may be anywhere in 0 to subBucketCount.
    // For other bucketIndex, this will always end up in the top half of subBucketCount: assume that for some bucket
    // k > 0, this calculation will yield a value in the bottom half of 0 to subBucketCount. Then, because of how
    // buckets overlap, it would have also been in the top half of bucket k-1, and therefore would have
    // returned k-1 in getBucketIndex(). Since we would then shift it one fewer bits here, it would be twice as big,
    // and therefore in the top half of subBucketCount.
    return <i32>(value >> (bucketIndex + this.unitMagnitude));
  }

  /**
   * Get the size (in value units) of the range of values that are equivalent to the given value within the
   * histogram's resolution. Where "equivalent" means that value samples recorded for any two
   * equivalent values are counted in a common total count.
   *
   * @param value The given value
   * @return The size of the range of values equivalent to the given value.
   */
  sizeOfEquivalentValueRange(value: u64): u64 {
    const bucketIndex = this.getBucketIndex(value);
    const distanceToNextValue = (<u64>1) << (this.unitMagnitude + bucketIndex);
    return distanceToNextValue;
  }

  /**
   * Get the lowest value that is equivalent to the given value within the histogram's resolution.
   * Where "equivalent" means that value samples recorded for any two
   * equivalent values are counted in a common total count.
   *
   * @param value The given value
   * @return The lowest value that is equivalent to the given value within the histogram's resolution.
   */
  lowestEquivalentValue(value: u64): u64 {
    const bucketIndex = this.getBucketIndex(value);
    const subBucketIndex = this.getSubBucketIndex(value, bucketIndex);
    const thisValueBaseLevel = this.valueFromIndexes(
      bucketIndex,
      subBucketIndex
    );
    return thisValueBaseLevel;
  }

  /**
   * Get the highest value that is equivalent to the given value within the histogram's resolution.
   * Where "equivalent" means that value samples recorded for any two
   * equivalent values are counted in a common total count.
   *
   * @param value The given value
   * @return The highest value that is equivalent to the given value within the histogram's resolution.
   */
  highestEquivalentValue(value: u64): u64 {
    return this.nextNonEquivalentValue(value) - 1;
  }

  /**
   * Get the next value that is not equivalent to the given value within the histogram's resolution.
   * Where "equivalent" means that value samples recorded for any two
   * equivalent values are counted in a common total count.
   *
   * @param value The given value
   * @return The next value that is not equivalent to the given value within the histogram's resolution.
   */
  nextNonEquivalentValue(value: u64): u64 {
    return (
      this.lowestEquivalentValue(value) + this.sizeOfEquivalentValueRange(value)
    );
  }

  /**
   * Get a value that lies in the middle (rounded up) of the range of values equivalent the given value.
   * Where "equivalent" means that value samples recorded for any two
   * equivalent values are counted in a common total count.
   *
   * @param value The given value
   * @return The value lies in the middle (rounded up) of the range of values equivalent the given value.
   */
  medianEquivalentValue(value: u64): u64 {
    return (
      this.lowestEquivalentValue(value) +
      (this.sizeOfEquivalentValueRange(value) >> 1)
    );
  }

  /**
   * Get the computed mean value of all recorded values in the histogram
   *
   * @return the mean value (in value units) of the histogram data
   */
  getMean(): f64 {
    if (this.totalCount === 0) {
      return 0;
    }
    this.recordedValuesIterator.reset();
    let totalValue = <u64>0;
    while (this.recordedValuesIterator.hasNext()) {
      const iterationValue = this.recordedValuesIterator.next();
      /*log<string>("iterationValue.valueIteratedTo");
      log<u64>(iterationValue.valueIteratedTo);
      log<string>("iterationValue.countAtValueIteratedTo");
      log<u64>(iterationValue.countAtValueIteratedTo);*/
      totalValue +=
        this.medianEquivalentValue(iterationValue.valueIteratedTo) *
        iterationValue.countAtValueIteratedTo;
    }
    //log<string>("totalValue");
    //log<u64>(totalValue);

    //log<string>("this.totalCount");
    //log<u64>(this.totalCount);

    return (<f64>totalValue * <f64>1) / <f64>this.totalCount;
  }

  /**
   * Get the computed standard deviation of all recorded values in the histogram
   *
   * @return the standard deviation (in value units) of the histogram data
   */
  getStdDeviation(): f64 {
    if (this.totalCount === 0) {
      return 0;
    }
    const mean = this.getMean();
    let geometric_deviation_total: f64 = 0.0;
    this.recordedValuesIterator.reset();
    while (this.recordedValuesIterator.hasNext()) {
      const iterationValue = this.recordedValuesIterator.next();
      const deviation =
        <f64>this.medianEquivalentValue(iterationValue.valueIteratedTo) - mean;
      geometric_deviation_total +=
        deviation *
        deviation *
        <f64>iterationValue.countAddedInThisIterationStep;
    }
    const std_deviation = Math.sqrt(
      geometric_deviation_total / <f64>this.totalCount
    );
    return std_deviation;
  }

  private updatedMaxValue(value: u64): void {
    const internalValue: u64 = value + this.unitMagnitudeMask;
    this.maxValue = internalValue;
  }

  private updateMinNonZeroValue(value: u64): void {
    if (value <= this.unitMagnitudeMask) {
      return;
    }
    const internalValue = value & ~this.unitMagnitudeMask; // Min unit-equivalent value;
    this.minNonZeroValue = internalValue;
  }

  updateMinAndMax(value: u64): void {
    if (value > this.maxValue) {
      this.updatedMaxValue(value);
    }
    if (value < this.minNonZeroValue && value !== 0) {
      this.updateMinNonZeroValue(value);
    }
  }

  recordCountAtValue(count: u64, value: u64): void {
    const countsIndex = this.countsArrayIndex(value);
    if (countsIndex >= this.countsArrayLength) {
      this.handleRecordException(count, value);
    } else {
      this.addToCountAtIndex(countsIndex, count);
    }
    this.updateMinAndMax(value);
    this.totalCount += count;
  }

  recordSingleValueWithExpectedInterval(
    value: u64,
    expectedIntervalBetweenValueSamples: u64
  ): void {
    this.recordSingleValue(value);
    if (expectedIntervalBetweenValueSamples <= 0) {
      return;
    }
    for (
      let missingValue = value - expectedIntervalBetweenValueSamples;
      missingValue >= expectedIntervalBetweenValueSamples;
      missingValue -= expectedIntervalBetweenValueSamples
    ) {
      this.recordSingleValue(missingValue);
    }
  }

  private recordValueWithCountAndExpectedInterval(
    value: u64,
    count: u64,
    expectedIntervalBetweenValueSamples: u64
  ): void {
    this.recordCountAtValue(count, value);
    if (value <= expectedIntervalBetweenValueSamples) {
      return;
    }

    for (
      let missingValue = value - expectedIntervalBetweenValueSamples;
      missingValue >= expectedIntervalBetweenValueSamples;
      missingValue -= expectedIntervalBetweenValueSamples
    ) {
      this.recordCountAtValue(count, missingValue);
    }
  }

  addWhileCorrectingForCoordinatedOmission(
    otherHistogram: Histogram<T, U>,
    expectedIntervalBetweenValueSamples: u64
  ): void {
    const toHistogram = this;

    const otherValues = new RecordedValuesIterator<T, U>(otherHistogram);

    while (otherValues.hasNext()) {
      const v = otherValues.next();
      toHistogram.recordValueWithCountAndExpectedInterval(
        v.valueIteratedTo,
        v.countAtValueIteratedTo,
        expectedIntervalBetweenValueSamples
      );
    }
  }

  copyCorrectedForCoordinatedOmission(
    expectedIntervalBetweenValueSamples: u64
  ): Histogram<T, U> {
    const copy = new Histogram<T, U>(
      this.lowestDiscernibleValue,
      this.highestTrackableValue,
      this.numberOfSignificantValueDigits
    );
    copy.addWhileCorrectingForCoordinatedOmission(
      this,
      expectedIntervalBetweenValueSamples
    );
    return copy;
  }

  /**
   * Get the value at a given percentile.
   * When the given percentile is &gt; 0.0, the value returned is the value that the given
   * percentage of the overall recorded value entries in the histogram are either smaller than
   * or equivalent to. When the given percentile is 0.0, the value returned is the value that all value
   * entries in the histogram are either larger than or equivalent to.
   * <p>
   * Note that two values are "equivalent" in this statement if
   * {@link org.HdrHistogram.AbstractHistogram#valuesAreEquivalent} would return true.
   *
   * @param percentile  The percentile for which to return the associated value
   * @return The value that the given percentage of the overall recorded value entries in the
   * histogram are either smaller than or equivalent to. When the percentile is 0.0, returns the
   * value that all value entries in the histogram are either larger than or equivalent to.
   */
  getValueAtPercentile(percentile: f64): u64 {
    const requestedPercentile = min(percentile, <f64>100); // Truncate down to 100%

    // round count up to nearest integer, to ensure that the largest value that the requested percentile
    // of overall recorded values is actually included. However, this must be done with care:
    //
    // First, Compute fp value for count at the requested percentile. Note that fp result end up
    // being 1 ulp larger than the correct integer count for this percentile:
    const fpCountAtPercentile =
      (requestedPercentile / 100.0) * <f64>this.totalCount;
    // Next, round up, but make sure to prevent <= 1 ulp inaccurancies in the above fp math from
    // making us skip a count:
    const countAtPercentile = <u64>max(
      ceil(fpCountAtPercentile - ulp(fpCountAtPercentile)), // round up
      1 // Make sure we at least reach the first recorded entry
    );

    let totalToCurrentIndex: u64 = 0;
    for (let i = 0; i < this.countsArrayLength; i++) {
      totalToCurrentIndex += this.getCountAtIndex(i);
      if (totalToCurrentIndex >= countAtPercentile) {
        var valueAtIndex: u64 = this.valueFromIndex(i);
        return percentile === 0.0
          ? this.lowestEquivalentValue(valueAtIndex)
          : this.highestEquivalentValue(valueAtIndex);
      }
    }
    return 0;
  }

  valueFromIndexes(bucketIndex: i32, subBucketIndex: i32): u64 {
    return (<u64>subBucketIndex) << (bucketIndex + this.unitMagnitude);
  }

  valueFromIndex(index: i32): u64 {
    //log<string>("index");
    //log<i32>(index);
    //log<string>("subBucketHalfCountMagnitude");
    //log<i32>(this.subBucketHalfCountMagnitude);
    let bucketIndex = (index >> this.subBucketHalfCountMagnitude) - 1;
    let subBucketIndex =
      (index & (this.subBucketHalfCount - 1)) + this.subBucketHalfCount;
    if (bucketIndex < 0) {
      subBucketIndex -= this.subBucketHalfCount;
      bucketIndex = 0;
    }
    //log<string>("bucketIndex");
    //log<i32>(bucketIndex);
    //log<string>("subBucketIndex");
    //log<i32>(subBucketIndex);
    return this.valueFromIndexes(bucketIndex, subBucketIndex);
  }

  incrementCountAtIndex(index: i32): void {
    // @ts-ignore
    const currentCount = unchecked(this.counts[index]);
    const newCount = currentCount + 1;
    if (newCount < 0) {
      throw newCount + " would overflow short integer count";
    }
    // @ts-ignore
    unchecked((this.counts[index] = newCount));
  }

  addToCountAtIndex(index: i32, value: u64): void {
    // @ts-ignore
    const currentCount = this.counts[index];
    const newCount = currentCount + value;
    if (newCount < 0) {
      throw newCount + " would overflow short integer count";
    }
    // @ts-ignore
    this.counts[index] = <U>newCount;
  }

  incrementTotalCount(): void {
    this.totalCount++;
  }

  getCountAtIndex(index: i32): u64 {
    // @ts-ignore
    return <u64>this.counts[index];
  }

  resize(newHighestTrackableValue: u64): void {
    this.establishSize(newHighestTrackableValue);
    const newCounts = instantiate<T>(this.countsArrayLength);
    // @ts-ignore
    newCounts.set(this.counts);
    this.counts = newCounts;
  }

  add<V, W>(otherHistogram: Histogram<V, W>): void {
    const highestRecordableValue = this.highestEquivalentValue(
      this.valueFromIndex(this.countsArrayLength - 1)
    );

    if (highestRecordableValue < otherHistogram.maxValue) {
      if (!this.autoResize) {
        throw new Error(
          "The other histogram includes values that do not fit in this histogram's range."
        );
      }
      this.resize(otherHistogram.maxValue);
    }

    if (
      this.bucketCount === otherHistogram.bucketCount &&
      this.subBucketCount === otherHistogram.subBucketCount &&
      this.unitMagnitude === otherHistogram.unitMagnitude
    ) {
      // Counts arrays are of the same length and meaning, so we can just iterate and add directly:
      let observedOtherTotalCount = <u64>0;
      for (let i = 0; i < otherHistogram.countsArrayLength; i++) {
        const otherCount = otherHistogram.getCountAtIndex(i);
        if (otherCount > 0) {
          this.addToCountAtIndex(i, otherCount);
          observedOtherTotalCount += otherCount;
        }
      }
      this.totalCount += observedOtherTotalCount;
      this.updatedMaxValue(max(this.maxValue, otherHistogram.maxValue));
      this.updateMinNonZeroValue(
        min(this.minNonZeroValue, otherHistogram.minNonZeroValue)
      );
    } else {
      // Arrays are not a direct match (or the other could change on the fly in some valid way),
      // so we can't just stream through and add them. Instead, go through the array and add each
      // non-zero value found at it's proper value:

      // Do max value first, to avoid max value updates on each iteration:
      const otherMaxIndex = otherHistogram.countsArrayIndex(
        otherHistogram.maxValue
      );
      let otherCount = otherHistogram.getCountAtIndex(otherMaxIndex);
      this.recordCountAtValue(otherCount, otherHistogram.maxValue);

      // Record the remaining values, up to but not including the max value:
      for (let i = 0; i < otherMaxIndex; i++) {
        otherCount = otherHistogram.getCountAtIndex(i);
        if (otherCount > 0) {
          this.recordCountAtValue(otherCount, otherHistogram.valueFromIndex(i));
        }
      }
    }
    this.startTimeStampMsec = min(
      this.startTimeStampMsec,
      otherHistogram.startTimeStampMsec
    );
    this.endTimeStampMsec = max(
      this.endTimeStampMsec,
      otherHistogram.endTimeStampMsec
    );
  }

  /**
   * Produce textual representation of the value distribution of histogram data by percentile. The distribution is
   * output with exponentially increasing resolution, with each exponentially decreasing half-distance containing
   * <i>dumpTicksPerHalf</i> percentile reporting tick points.
   *
   * @param printStream    Stream into which the distribution will be output
   * <p>
   * @param percentileTicksPerHalfDistance  The number of reporting points per exponentially decreasing half-distance
   * <p>
   * @param outputValueUnitScalingRatio    The scaling factor by which to divide histogram recorded values units in
   *                                     output
   * @param useCsvFormat  Output in CSV format if true. Otherwise use plain text form.
   */
  outputPercentileDistribution(
    percentileTicksPerHalfDistance: i32 = 5,
    outputValueUnitScalingRatio: f64 = 1
  ): string {
    let result = "";
    result += "       Value     Percentile TotalCount 1/(1-Percentile)\n\n";

    const iterator = this.percentileIterator;
    iterator.reset(percentileTicksPerHalfDistance);

    const valueFormatter = new FloatFormatter(
      12,
      this.numberOfSignificantValueDigits
    );
    const percentileFormatter = new FloatFormatter(2, 12);
    const totalCountFormatter = new IntegerFormatter(10);
    const lastFormatter = new FloatFormatter(14, 2);

    while (iterator.hasNext()) {
      const iterationValue = iterator.next();
      if (iterationValue.percentileLevelIteratedTo < 100) {
        result +=
          valueFormatter.format(
            <f64>iterationValue.valueIteratedTo / outputValueUnitScalingRatio
          ) +
          " " +
          percentileFormatter.format(
            iterationValue.percentileLevelIteratedTo / <f64>100
          ) +
          " " +
          totalCountFormatter.format(iterationValue.totalCountToThisValue) +
          " " +
          lastFormatter.format(
            <f64>1 /
              (<f64>1 - iterationValue.percentileLevelIteratedTo / <f64>100)
          ) +
          "\n";
      } else {
        result +=
          valueFormatter.format(
            <f64>iterationValue.valueIteratedTo / outputValueUnitScalingRatio
          ) +
          " " +
          percentileFormatter.format(
            iterationValue.percentileLevelIteratedTo / <f64>100
          ) +
          " " +
          totalCountFormatter.format(iterationValue.totalCountToThisValue) +
          "\n";
      }
    }

    // Calculate and output mean and std. deviation.
    // Note: mean/std. deviation numbers are very often completely irrelevant when
    // data is extremely non-normal in distribution (e.g. in cases of strong multi-modal
    // response time distribution associated with GC pauses). However, reporting these numbers
    // can be very useful for contrasting with the detailed percentile distribution
    // reported by outputPercentileDistribution(). It is not at all surprising to find
    // percentile distributions where results fall many tens or even hundreds of standard
    // deviations away from the mean - such results simply indicate that the data sampled
    // exhibits a very non-normal distribution, highlighting situations for which the std.
    // deviation metric is a useless indicator.
    //
    const formatter = new FloatFormatter(
      12,
      this.numberOfSignificantValueDigits
    );
    const mean = formatter.format(this.getMean() / outputValueUnitScalingRatio);
    const std_deviation = formatter.format(
      this.getStdDeviation() / outputValueUnitScalingRatio
    );
    const max = formatter.format(
      <f64>this.maxValue / outputValueUnitScalingRatio
    );
    const intFormatter = new IntegerFormatter(12);
    const totalCount = intFormatter.format(this.totalCount);
    const bucketCount = intFormatter.format(this.bucketCount);
    const subBucketCount = intFormatter.format(this.subBucketCount);
    // #[Mean    =         50.0,
    // #[Mean    =       50.000,
    result +=
      `#[Mean    = ` +
      mean.toString() +
      `, StdDeviation   = ` +
      std_deviation.toString() +
      `]
#[Max     = ` +
      max.toString() +
      `, Total count    = ` +
      totalCount.toString() +
      `]
#[Buckets = ` +
      bucketCount.toString() +
      `, SubBuckets     = ` +
      subBucketCount.toString() +
      `]
`;

    return result;
  }

  clearCounts(): void {
    // @ts-ignore
    this.counts.fill(0);
  }

  reset(): void {
    this.clearCounts();
    this.totalCount = 0;
    this.startTimeStampMsec = 0;
    this.endTimeStampMsec = 0;
    //this.tag = NO_TAG;
    this.maxValue = 0;
    this.minNonZeroValue = U64.MAX_VALUE;
  }
}

export class Histogram8 extends Histogram<Uint8Array, u8> {}
export class Histogram16 extends Histogram<Uint16Array, u16> {}
export class Histogram32 extends Histogram<Uint32Array, u32> {}
export class Histogram64 extends Histogram<Uint64Array, u64> {}