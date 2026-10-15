import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";

// H-306: register() dynamically imports @/server/db-timezone after the env
// contract passes. The mock wraps the real module so DatabaseTimeZoneError
// stays the genuine class (the instanceof gate inside register must match).
vi.mock("@/server/db-timezone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db-timezone")>();
  return { ...actual, verifyDatabaseTimeZone: vi.fn(actual.verifyDatabaseTimeZone) };
});

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

const VALID_ENV = {
  DATABASE_URL: "postgresql://huk:huk@localhost:5432/huk",
  AUTH_SECRET: "test-only fixture value, not a credential",
};

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
    process.env = { ...savedEnv, ...VALID_ENV };

    await expect(register()).resolves.toBeUndefined();
  });

  it("runs the database time-zone check after the env contract (H-306)", async () => {
    process.env = { ...savedEnv, ...VALID_ENV };
    const { verifyDatabaseTimeZone } = await import("@/server/db-timezone");
    const verify = vi.mocked(verifyDatabaseTimeZone);
    verify.mockClear().mockResolvedValue(undefined);

    await expect(register()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("exits non-zero with the fix message when the effective zone is not UTC (H-306)", async () => {
    process.env = { ...savedEnv, ...VALID_ENV };
    const { verifyDatabaseTimeZone, DatabaseTimeZoneError } = await import("@/server/db-timezone");
    vi.mocked(verifyDatabaseTimeZone)
      .mockClear()
      .mockRejectedValue(new DatabaseTimeZoneError("Europe/Minsk"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("__process_exit__");
      }) as never);

    await expect(register()).rejects.toThrow("__process_exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Europe\/Minsk/));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Fix:/));
  });

  it("keeps booting (warn only) when the database is unreachable at boot (H-306)", async () => {
    process.env = { ...savedEnv, ...VALID_ENV };
    const { verifyDatabaseTimeZone } = await import("@/server/db-timezone");
    vi.mocked(verifyDatabaseTimeZone)
      .mockClear()
      .mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await expect(register()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/time-zone check could not run/));
  });
});
