import { singleFlight, SingleFlightTimeoutError } from "./single-flight";

describe("singleFlight", () => {
  it("coalesces 100 concurrent identical reads into one execution", async () => {
    let executions = 0;

    const query = async () => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { value: "result" };
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        singleFlight("popular-key", async () => query()),
      ),
    );

    expect(executions).toBe(1);
    expect(results).toHaveLength(100);
    expect(results.every((result) => result.value === "result")).toBe(true);
  });

  it("does not coalesce different keys", async () => {
    let executions = 0;

    const query = async (key: string) => {
      executions++;
      return key;
    };

    const [first, second] = await Promise.all([
      singleFlight("key-a", () => query("a"), 0),
      singleFlight("key-b", () => query("b"), 0),
    ]);

    expect(executions).toBe(2);
    expect(first).toBe("a");
    expect(second).toBe("b");
  });

  it("reuses successful results within the cache TTL", async () => {
    let executions = 0;

    const query = async () => {
      executions++;
      return "cached";
    };

    await singleFlight("cache-key", query, 1000);
    await singleFlight("cache-key", query, 1000);

    expect(executions).toBe(1);
  });

  it("does not cache failed operations", async () => {
    let executions = 0;

    const query = async () => {
      executions++;
      throw new Error("Query failed");
    };

    await expect(singleFlight("failure-key", query)).rejects.toThrow(
      "Query failed",
    );

    await expect(singleFlight("failure-key", query)).rejects.toThrow(
      "Query failed",
    );

    expect(executions).toBe(2);
  });

  it("propagates the same failure to concurrent callers", async () => {
    let executions = 0;

    const query = async () => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 25));
      throw new Error("Shared failure");
    };

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        singleFlight("shared-failure", query),
      ),
    );

    expect(executions).toBe(1);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
  });

  it("times out a stuck leader and releases the key for retry", async () => {
    let executions = 0;

    const stuckQuery = (_signal: AbortSignal) =>
      new Promise<string>(() => {
        // Intentionally never resolves.
      });

    const first = singleFlight(
      "timeout-key",
      (signal) => {
        executions++;
        return stuckQuery(signal);
      },
      1000,
      { timeoutMs: 30 },
    );

    await expect(first).rejects.toThrow(SingleFlightTimeoutError);

    const retry = await singleFlight(
      "timeout-key",
      async () => {
        executions++;
        return "recovered";
      },
      0,
    );

    expect(retry).toBe("recovered");
    expect(executions).toBe(2);
  });

  it("records coalesced request metrics", async () => {
    let coalesced = 0;

    const query = () =>
      new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 20));

    await Promise.all([
      singleFlight("metrics-key", query, 0, {
        metrics: {
          coalescedRequests: (count = 1) => {
            coalesced += count;
          },
        },
      }),
      singleFlight("metrics-key", query, 0, {
        metrics: {
          coalescedRequests: (count = 1) => {
            coalesced += count;
          },
        },
      }),
    ]);

    expect(coalesced).toBeGreaterThanOrEqual(1);
  });
});