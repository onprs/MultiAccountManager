"use client";

import { Eye, EyeOff } from "lucide-react";
import { useId, useState } from "react";

export function SecretInput({
  label,
  name,
  defaultValue,
  autoComplete = "off",
  maxLength = 2_000,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();

  return (
    <div className="block min-w-0 space-y-2">
      <label htmlFor={inputId} className="block text-xs font-semibold text-[var(--muted)]">{label}</label>
      <div className="relative">
        <input
          id={inputId}
          name={name}
          type={visible ? "text" : "password"}
          defaultValue={defaultValue}
          autoComplete={autoComplete}
          maxLength={maxLength}
          spellCheck={false}
          className="min-h-10 w-full min-w-0 rounded-[6px] border border-[var(--border)] bg-white px-3 py-2 pr-11 text-sm"
        />
        <button
          type="button"
          title={visible ? `隐藏${label}` : `显示${label}`}
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
          onClick={() => setVisible((current) => !current)}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {visible ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
        </button>
      </div>
    </div>
  );
}
