// ====================================================================
// Environment validation tests.
// ====================================================================

import { describe, it, expect } from "vitest";
import { validateEnvironment } from "@/lib/env";

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    AUTH_SECRET: "a".repeat(48),
    DATABASE_URL: "postgresql://user:strongpassword@db:5432/app?schema=public",
    NEXTAUTH_URL: "https://app.example.com",
    EMAIL_TRANSPORT: "smtp",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "user",
    SMTP_PASSWORD: "pass",
    EMAIL_FROM: "no-reply@example.com",
    PAYMENT_GATEWAY: "manual",
    STORAGE_PROVIDER: "minio",
    MINIO_ENDPOINT: "http://minio:9000",
    MINIO_ACCESS_KEY: "key",
    MINIO_SECRET_KEY: "secret",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("env: production happy path", () => {
  it("returns ok=true when all required envs are set", () => {
    const result = validateEnvironment(makeEnv({ NODE_ENV: "production" }));
    expect(result.ok).toBe(true);
    expect(result.isProduction).toBe(true);
  });
});

describe("env: rejects weak AUTH_SECRET in production", () => {
  it("errors when AUTH_SECRET missing", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", AUTH_SECRET: undefined })
    );
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.key === "AUTH_SECRET")?.level).toBe("error");
  });

  it("errors when AUTH_SECRET is too short", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", AUTH_SECRET: "short" })
    );
    expect(result.ok).toBe(false);
  });

  it("errors when AUTH_SECRET is a placeholder", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        AUTH_SECRET: "change-me-to-a-long-random-string-min-32-chars",
      })
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.find(
        (i) => i.key === "AUTH_SECRET" && i.level === "error"
      )
    ).toBeDefined();
  });
});

describe("env: rejects missing DATABASE_URL in production", () => {
  it("errors when DATABASE_URL missing", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", DATABASE_URL: undefined })
    );
    expect(result.ok).toBe(false);
  });

  it("errors when DATABASE_URL contains the default dev password 'taswerak'", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://taswerak:taswerak@db:5432/app",
      })
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.find(
        (i) => i.key === "DATABASE_URL" && i.level === "error"
      )
    ).toBeDefined();
  });
});

describe("env: requires HTTPS NEXTAUTH_URL in production", () => {
  it("errors when NEXTAUTH_URL is http in production", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", NEXTAUTH_URL: "http://app.example.com" })
    );
    expect(result.ok).toBe(false);
  });
});

describe("env: SMTP must be configured in production", () => {
  it("errors when EMAIL_TRANSPORT=simulation in production", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        EMAIL_TRANSPORT: "simulation",
        SMTP_HOST: undefined,
        SMTP_USER: undefined,
        SMTP_PASSWORD: undefined,
      })
    );
    expect(result.ok).toBe(false);
  });

  it("errors when SMTP_HOST missing but transport=smtp", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", SMTP_HOST: undefined })
    );
    expect(result.ok).toBe(false);
  });
});

describe("env: payment gateway must have keys", () => {
  it("errors when PAYMENT_GATEWAY=moyasar but key missing", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        PAYMENT_GATEWAY: "moyasar",
        MOYASAR_SECRET_KEY: undefined,
      })
    );
    expect(result.ok).toBe(false);
  });

  it("errors when PAYMENT_GATEWAY=tap but key missing", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        PAYMENT_GATEWAY: "tap",
        TAP_SECRET_KEY: undefined,
      })
    );
    expect(result.ok).toBe(false);
  });
});

describe("env: demo seed forbidden in production", () => {
  it("errors when ENABLE_DEMO_SEED=true in production", () => {
    const result = validateEnvironment(
      makeEnv({ NODE_ENV: "production", ENABLE_DEMO_SEED: "true" })
    );
    expect(result.ok).toBe(false);
    expect(
      result.issues.find((i) => i.key === "ENABLE_DEMO_SEED")
    ).toBeDefined();
  });

  it("warns but does not fail when SEED_ADMIN_* not set in production", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        SEED_ADMIN_EMAIL: undefined,
        SEED_ADMIN_PASSWORD: undefined,
      })
    );
    // It's a warning, not an error — ok should remain true (assuming all
    // other env is fine)
    expect(result.issues.find((i) => i.key === "SEED_ADMIN_*")?.level).toBe("warn");
  });

  it("errors when SEED_ADMIN_PASSWORD is weak", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        SEED_ADMIN_EMAIL: "admin@x.com",
        SEED_ADMIN_PASSWORD: "short",
      })
    );
    expect(result.ok).toBe(false);
  });
});

describe("env: local storage warning", () => {
  it("warns when local storage used in production without LOCAL_STORAGE_DIR", () => {
    const result = validateEnvironment(
      makeEnv({
        NODE_ENV: "production",
        STORAGE_PROVIDER: "local",
        LOCAL_STORAGE_DIR: undefined,
      })
    );
    const w = result.issues.find((i) => i.key === "LOCAL_STORAGE_DIR");
    expect(w).toBeDefined();
    expect(w?.level).toBe("warn");
  });
});

describe("env: non-production is permissive", () => {
  it("returns ok=true in development even with missing secrets", () => {
    const result = validateEnvironment({
      NODE_ENV: "development",
      AUTH_SECRET: undefined,
      DATABASE_URL: undefined,
    });
    // ok=true because errors are demoted to warnings in non-prod
    expect(result.ok).toBe(true);
    expect(result.isProduction).toBe(false);
  });
});

// ====================================================================
// Boot-time environment validation test
// Simulates what scripts/assert-env.js does at container startup.
// ====================================================================

describe("env: boot-time validation (scripts/assert-env.js)", () => {
  it("production process refuses to boot with missing AUTH_SECRET", () => {
    const result = validateEnvironment({
      NODE_ENV: "production",
      AUTH_SECRET: undefined,
      DATABASE_URL: "postgresql://user:strongpw@db:5432/app",
      NEXTAUTH_URL: "https://app.example.com",
      EMAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user",
      SMTP_PASSWORD: "pass",
      EMAIL_FROM: "no-reply@example.com",
      PAYMENT_GATEWAY: "manual",
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: "/app/.upload",
    });
    expect(result.ok).toBe(false);
    expect(result.isProduction).toBe(true);
    // assert-env.js would exit(1) here in production
  });

  it("production process refuses to boot with simulation email transport", () => {
    const result = validateEnvironment({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(48),
      DATABASE_URL: "postgresql://user:strongpw@db:5432/app",
      NEXTAUTH_URL: "https://app.example.com",
      EMAIL_TRANSPORT: "simulation",
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: "/app/.upload",
      PAYMENT_GATEWAY: "manual",
    });
    expect(result.ok).toBe(false);
    // EMAIL_TRANSPORT=simulation is forbidden in production
    expect(result.issues.find((i) => i.key === "EMAIL_TRANSPORT")).toBeDefined();
  });

  it("production process refuses to boot with ENABLE_DEMO_SEED=true", () => {
    const result = validateEnvironment({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(48),
      DATABASE_URL: "postgresql://user:strongpw@db:5432/app",
      NEXTAUTH_URL: "https://app.example.com",
      EMAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user",
      SMTP_PASSWORD: "pass",
      EMAIL_FROM: "no-reply@example.com",
      PAYMENT_GATEWAY: "manual",
      STORAGE_PROVIDER: "local",
      LOCAL_STORAGE_DIR: "/app/.upload",
      ENABLE_DEMO_SEED: "true",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.find((i) => i.key === "ENABLE_DEMO_SEED")).toBeDefined();
  });

  it("production process boots successfully with all env vars set", () => {
    const result = validateEnvironment({
      NODE_ENV: "production",
      AUTH_SECRET: "a".repeat(48),
      DATABASE_URL: "postgresql://user:strongpw@db:5432/app",
      NEXTAUTH_URL: "https://app.example.com",
      EMAIL_TRANSPORT: "smtp",
      SMTP_HOST: "smtp.example.com",
      SMTP_USER: "user",
      SMTP_PASSWORD: "pass",
      EMAIL_FROM: "no-reply@example.com",
      PAYMENT_GATEWAY: "manual",
      STORAGE_PROVIDER: "minio",
      MINIO_ENDPOINT: "http://minio:9000",
      MINIO_ACCESS_KEY: "key",
      MINIO_SECRET_KEY: "secret",
    });
    expect(result.ok).toBe(true);
    expect(result.isProduction).toBe(true);
  });
});
