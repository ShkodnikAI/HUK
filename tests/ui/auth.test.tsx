// @vitest-environment jsdom
// H-122 task 7: the access screens — no password input anywhere, the same
// outcome for known and unknown addresses, the calm rate-limit message,
// identical invite-failure messages, the Me tab states, locale preserved.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInScreen } from "@/components/auth/SignInScreen";
import { CheckEmailScreen } from "@/components/auth/CheckEmailScreen";
import { AuthErrorScreen } from "@/components/auth/AuthErrorScreen";
import { InviteScreen } from "@/components/auth/InviteScreen";
import { MeView } from "@/components/auth/MeView";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

function Providers({ children, locale = "en" }: { children: React.ReactNode; locale?: string }) {
  const catalog = locale === "ru" ? ru : en;
  return (
    <NextIntlClientProvider locale={locale} messages={catalog} now={new Date("2026-01-15T12:00:00Z")}>
      {children}
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function stubAuthFetch(handlers: Array<{ match: (url: string, method: string) => boolean; respond: () => Response }>): void {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    for (const h of handlers) {
      if (h.match(url, method)) return h.respond();
    }
    return new Response("{}", { status: 200 });
  };
  vi.stubGlobal("fetch", impl);
}

describe("sign-in screen (H-122 task 2)", () => {
  it("renders an email field, a link-will-be-sent copy, and NO password input anywhere", () => {
    stubAuthFetch([]);
    render(<Providers><SignInScreen /></Providers>);
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(screen.queryByText(/password/i, { selector: "input" })).toBeNull();
    expect(screen.getByText(/one-time sign-in link/)).toBeTruthy();
  });

  it("requests the CSRF token, posts it with the email, and navigates to check-email — the SAME way for a known and an unknown address", async () => {
    for (const email of ["known@test.example", "never-seen@test.example"]) {
      const posted: string[] = [];
      stubAuthFetch([
        {
          match: (url, method) => url.includes("/api/auth/csrf") && method === "GET",
          respond: () => new Response(JSON.stringify({ csrfToken: "tok-123" }), { status: 200 }),
        },
        {
          match: (url, method) => url.includes("/api/auth/signin/email") && method === "POST",
          respond: () => {
            posted.push(email);
            // Auth.js answers a redirect regardless of account existence.
            try {
              return new Response(null, { status: 302 });
            } catch (e) {
              return new Response("{}", { status: 200 });
            }
          },
        },
      ]);
      render(<Providers><SignInScreen /></Providers>);
      await act(async () => {
        fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
        fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
      });
      await new Promise((r) => setTimeout(r, 200));
      await waitFor(() => expect(push).toHaveBeenCalledWith("/en/check-email"));
      expect(posted).toEqual([email]); // the POST carried THIS address, whatever it is
      cleanup();
      push.mockClear();
    }
  });

  it("shows a calm wait-time message on 429 (no countdown, no oracle)", async () => {
    stubAuthFetch([
      { match: (url) => url.includes("/api/auth/csrf"), respond: () => new Response(JSON.stringify({ csrfToken: "t" }), { status: 200 }) },
      {
        match: (url, method) => url.includes("/api/auth/signin/email") && method === "POST",
        respond: () => new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), { status: 429, headers: { "retry-after": "300" } }),
      },
    ]);
    render(<Providers><SignInScreen /></Providers>);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@test.example" } });
      fireEvent.click(screen.getByRole("button", { name: "Send the link" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("5 min"));
    expect(push).not.toHaveBeenCalled();
  });

  it("preserves the locale (the ru provider renders Russian text)", () => {
    stubAuthFetch([]);
    render(<Providers locale="ru"><SignInScreen /></Providers>);
    expect(screen.getByRole("button", { name: "Отправить ссылку" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });
});

describe("check-your-email screen (H-122 task 3)", () => {
  it("shows the entered address, the use-another-address action and the spam hint — no countdown", async () => {
    sessionStorage.setItem("huk-signin-email", "me@test.example");
    render(<Providers><CheckEmailScreen /></Providers>);
    await waitFor(() => expect(screen.getByText(/me@test\.example/)).toBeTruthy());
    expect(screen.getByRole("link", { name: "Use another address" })).toBeTruthy();
    expect(screen.getByText(/spam folder/i)).toBeTruthy();
    // No countdown implies no delivery guarantee: no ticking digits.
    expect(screen.queryByText(/\d+…$/)).toBeNull();
  });

  it("stays honest when the address is unknown (generic wording)", () => {
    render(<Providers><CheckEmailScreen /></Providers>);
    expect(screen.getByText(/We sent a sign-in link to your address\./)).toBeTruthy();
  });
});

describe("error screen (H-122 task 4)", () => {
  it("shows the SAME plain words for every Auth.js error value — no internal detail", async () => {
    for (const code of ["Verification", "Configuration", "SomethingElse"]) {
      window.history.replaceState(null, "", `/en/auth-error?error=${code}`);
      render(<Providers><AuthErrorScreen /></Providers>);
      await waitFor(() => expect(screen.getByText("This link no longer works")).toBeTruthy());
      expect(screen.getByText(/invalid, expired or already used/)).toBeTruthy();
      expect(screen.getByRole("link", { name: "Back to sign-in" })).toBeTruthy();
      // No provider detail, no stack, no raw error code.
      expect(document.body.textContent).not.toContain(code);
      cleanup();
    }
  });
});

describe("invite screen (H-122 task 5)", () => {
  const FIELDS = () => ({
    code: screen.getByLabelText("Invite code"),
    handle: screen.getByLabelText("Handle"),
    name: screen.getByLabelText("Display name"),
  });

  it("unknown, reused and malformed codes get ONE identical message (mirrors the API 404)", async () => {
    let respondWith = 404;
    stubAuthFetch([
      {
        match: (url, method) => url.includes("/api/invites/redeem") && method === "POST",
        respond: () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: respondWith }),
      },
    ]);
    for (const code of ["no-such-code", "already-used-code", "!!"]) {
      render(<Providers><InviteScreen /></Providers>);
      const f = FIELDS();
      await act(async () => {
        fireEvent.change(f.code, { target: { value: code } });
        fireEvent.change(f.handle, { target: { value: "artist" } });
        fireEvent.change(f.name, { target: { value: "Artist" } });
        fireEvent.click(screen.getByRole("button", { name: "Redeem the code" }));
      });
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("This code does not work — check it or ask for a new one."));
      expect(push).not.toHaveBeenCalled();
      cleanup();
      respondWith = 404; // the API answers the same generic 404 every time
    }
  });

  it("429 shows the wait time; success navigates to the artist area", async () => {
    stubAuthFetch([
      {
        match: (url, method) => url.includes("/api/invites/redeem") && method === "POST",
        respond: () => new Response("{}", { status: 429, headers: { "retry-after": "120" } }),
      },
    ]);
    render(<Providers><InviteScreen /></Providers>);
    const f = FIELDS();
    await act(async () => {
      fireEvent.change(f.code, { target: { value: "c" } });
      fireEvent.change(f.handle, { target: { value: "a" } });
      fireEvent.change(f.name, { target: { value: "A" } });
      fireEvent.click(screen.getByRole("button", { name: "Redeem the code" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("2 min"));
    expect(push).not.toHaveBeenCalled();
    cleanup();

    stubAuthFetch([
      {
        match: (url, method) => url.includes("/api/invites/redeem") && method === "POST",
        respond: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);
    render(<Providers><InviteScreen /></Providers>);
    const g = FIELDS();
    await act(async () => {
      fireEvent.change(g.code, { target: { value: "good" } });
      fireEvent.change(g.handle, { target: { value: "artist" } });
      fireEvent.change(g.name, { target: { value: "Artist" } });
      fireEvent.click(screen.getByRole("button", { name: "Redeem the code" }));
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/submit"));
  });
});

describe("Me tab (H-122 task 6)", () => {
  it("signed out: a sign-in button", () => {
    render(<Providers><MeView signedIn={false} /></Providers>);
    expect(screen.getByRole("link", { name: "Sign in" })).toBeTruthy();
  });

  it("signed in listener (invite-only beta): email, role, invite link, sign out", () => {
    render(<Providers><MeView signedIn email="l@test.example" role="LISTENER" inviteApplicable /></Providers>);
    expect(screen.getByText("l@test.example")).toBeTruthy();
    expect(screen.getByText("LISTENER")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Redeem an artist invite" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("an artist gets NO invite link; the data-screen link does not exist yet (H-214)", () => {
    render(<Providers><MeView signedIn email="a@test.example" role="ARTIST" inviteApplicable={false} /></Providers>);
    expect(screen.queryByRole("link", { name: /invite/i })).toBeNull();
    expect(screen.queryByText(/export|delete/i)).toBeNull();
  });
});
