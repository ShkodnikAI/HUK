// H-120 task 7: shared helpers for the UI test harness.
import { render, type RenderOptions } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";

export const messages = { en, ru };

/** Renders under a NextIntlClientProvider carrying the real en catalog. */
export function renderWithMessages(ui: ReactElement, options: Omit<RenderOptions, "wrapper"> = {}): RenderOptions extends never ? never : ReturnType<typeof render> {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={en} now={new Date("2026-01-15T12:00:00Z")}>
        {children}
      </NextIntlClientProvider>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export { ru as ruMessages };
