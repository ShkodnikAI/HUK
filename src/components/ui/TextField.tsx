"use client";

// H-120 task 4: TextField and TextArea — visible label, optional help
// text, optional error text, wired with aria-describedby. The error text
// is announced (role="alert") and linked the same way.

import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

const FIELD_CLASSES =
  "focus-gold min-h-[44px] w-full rounded-xl border border-border bg-sunken px-3 py-2 text-text placeholder:text-muted";

type FieldShellProps = {
  label: string;
  helpText?: ReactNode;
  errorText?: ReactNode;
  children: (ids: { describedBy: string | undefined; labelId: string; inputId: string }) => ReactNode;
};

function FieldShell({ label, helpText, errorText, children }: FieldShellProps) {
  const labelId = useId();
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const describedBy = [helpText ? helpId : null, errorText ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={inputId} id={labelId} className="text-sm font-medium text-muted">
        {label}
      </label>
      {children({ describedBy, labelId, inputId })}
      {helpText ? (
        <p id={helpId} className="text-xs text-muted">
          {helpText}
        </p>
      ) : null}
      {errorText ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  helpText?: ReactNode;
  errorText?: ReactNode;
};

export function TextField({ label, helpText, errorText, className = "", ...rest }: TextFieldProps) {
  return (
    <FieldShell label={label} helpText={helpText} errorText={errorText}>
      {({ describedBy, inputId }) => (
        <input
          id={inputId}
          className={`${FIELD_CLASSES} ${className}`}
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  helpText?: ReactNode;
  errorText?: ReactNode;
  rows?: number;
};

export function TextArea({ label, helpText, errorText, rows = 4, className = "", ...rest }: TextAreaProps) {
  return (
    <FieldShell label={label} helpText={helpText} errorText={errorText}>
      {({ describedBy, inputId }) => (
        <textarea
          id={inputId}
          rows={rows}
          className={`${FIELD_CLASSES} rounded-xl py-2 ${className}`}
          aria-describedby={describedBy}
          aria-invalid={errorText ? true : undefined}
          {...rest}
        />
      )}
    </FieldShell>
  );
}
