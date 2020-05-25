/*
 * This is a TypeScript port of the original Java version, which was written by
 * Gil Tene as described in
 * https://github.com/HdrHistogram/HdrHistogram
 * and released to the public domain, as explained at
 * http://creativecommons.org/publicdomain/zero/1.0/
 */
import * as fc from "fast-check";
import * as hdr from "./index";
import { initWebAssembly } from "./wasm";

const runFromStryker = __dirname.includes("stryker");

const runnerOptions = {
  numRuns: runFromStryker ? 10 : 1000,
  verbose: true,
};

type BucketSize = 8 | 16 | 32 | 64 | "packed";

describe("Histogram percentile computation", () => {
  const numberOfSignificantValueDigits = 3;
  [true, false].forEach((useWebAssembly) =>
    [32, "packed"].forEach((bitBucketSize: any) =>
      it(`Histogram ${bitBucketSize} (wasm: ${useWebAssembly}) should be accurate according to its significant figures`, async () => {
        await initWebAssembly();
        const histogram = hdr.build({
          bitBucketSize,
          numberOfSignificantValueDigits,
          useWebAssembly,
          autoResize: false,
          highestTrackableValue: Number.MAX_SAFE_INTEGER,
        });
        fc.assert(
          fc.property(arbData(2000), (numbers) => {
            histogram.reset();
            numbers.forEach((n) => histogram.recordValue(n));
            const actual = quantile(numbers, 90);
            const got = histogram.getValueAtPercentile(90);
            const relativeError = Math.abs(1 - got / actual);
            const variation = Math.pow(10, -numberOfSignificantValueDigits);
            return relativeError < variation;
          }),
          runnerOptions
        );
        histogram.destroy();
      })
    )
  );
});
describe("Histogram percentile computation", () => {
  const numberOfSignificantValueDigits = 3;
  [true, false].forEach((useWebAssembly) =>
    [8, 16, 32, 64, "packed"].forEach((bitBucketSize: BucketSize) =>
      it(`Histogram ${bitBucketSize} (wasm: ${useWebAssembly}) should be accurate according to its significant figures`, async () => {
        await initWebAssembly();

        fc.assert(
          fc.property(arbData(2000), (numbers) => {
            const histogram = hdr.build({
              bitBucketSize,
              numberOfSignificantValueDigits,
              useWebAssembly,
            });
            numbers.forEach((n) => histogram.recordValue(n));
            const actual = quantile(numbers, 90);
            const got = histogram.getValueAtPercentile(90);
            const relativeError = Math.abs(1 - got / actual);
            const variation = Math.pow(10, -numberOfSignificantValueDigits);
            histogram.destroy();
            return relativeError < variation;
          }),
          runnerOptions
        );
      })
    )
  );
});

describe.only("Histogram percentile computation (packed vs classic)", () => {
  const numberOfSignificantValueDigits = 3;
  const classicHistogram = hdr.build({
    numberOfSignificantValueDigits,
  });
  const histogram = hdr.build({
    numberOfSignificantValueDigits,
    bitBucketSize: "packed",
    useWebAssembly: false,
  });

  it(`should be accurate according to its significant figures`, () => {
    fc.assert(
      fc.property(arbData(5), (numbers) => {
        histogram.reset();
        classicHistogram.reset();
        numbers.forEach((n) => histogram.recordValue(n));
        numbers.forEach((n) => classicHistogram.recordValue(n));
        const actual = classicHistogram.getValueAtPercentile(90);
        const got = histogram.getValueAtPercentile(90);
        return actual === got;
      }),
      runnerOptions
    );
  });
});

describe("Histogram encoding/decoding", () => {
  const numberOfSignificantValueDigits = 3;
  [true, false].forEach((useWebAssembly) =>
    [8, 16, 32, 64, "packed"].forEach((bitBucketSize: BucketSize) => {
      it(`Histogram ${bitBucketSize} (wasm: ${useWebAssembly}) should keep all data after an encoding/decoding roundtrip`, async () => {
        await initWebAssembly();
        fc.assert(
          fc.property(arbData(1), fc.double(50, 100), (numbers, percentile) => {
            const histogram = hdr.build({
              bitBucketSize,
              numberOfSignificantValueDigits,
              useWebAssembly,
            }) as hdr.AbstractHistogram;
            numbers.forEach((n) => histogram.recordValue(n));
            const encodedHistogram = hdr.encodeIntoCompressedBase64(histogram);
            const decodedHistogram = hdr.decodeFromCompressedBase64(
              encodedHistogram
            );
            const actual = histogram.getValueAtPercentile(percentile);
            const got = decodedHistogram.getValueAtPercentile(percentile);
            histogram.destroy();
            decodedHistogram.destroy();
            return actual === got;
          }),
          runnerOptions
        );
      });
    })
  );
});

const arbData = (size: number) =>
  fc.array(fc.integer(1, Number.MAX_SAFE_INTEGER), size, size);

// reference implementation
const quantile = (inputData: number[], percentile: number) => {
  const data = [...inputData].sort((a, b) => a - b);
  const index = (percentile / 100) * (data.length - 1);
  let result: number;
  if (Math.floor(index) === index) {
    result = data[index];
  } else {
    const i = Math.floor(index);
    const fraction = index - i;
    result = data[i] + (data[i + 1] - data[i]) * fraction;
  }
  return result;
};
