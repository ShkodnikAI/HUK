import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("instrumentation.register (H-107, S8 at boot)", () => {
  it("exits non-zero with the S8 message when the environment is invalid", async () => {
    // Emulate a server boot with a broken env. The build-phase skip must not
    // trigger: phase-production-build is the only silenced phase.
    process.env = {
      ...savedEnv,
      NEXT_PHASE: "phase-production-server",
      DATABASE_URL: "not-a-url",
    };
    delete process.env.AUTH_SECRET;

    // register() must fail loud (S9): print the S8 message and hard-exit, so
    // Next cannot demote the failure to an unhandledRejection and keep serving.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("__process_exit__");
      }) as never);

    await expect(register()).rejects.toThrow("__process_exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid environment \(S8\)/));
  });

  it("resolves and validates once when the environment is valid", async () => {
    process.env = {
      ...savedEnv,
      DATABASE_URL: "postgresql://huk:huk@localhost:5432/huk",
      AUTH_SECRET: "test-only fixture value, not a credential",
    };

    await expect(register()).resolves.toBeUndefined();
  });
});
