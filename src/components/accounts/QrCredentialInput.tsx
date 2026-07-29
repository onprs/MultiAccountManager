"use client";

import { ImageUp, LoaderCircle } from "lucide-react";
import { ChangeEvent, useState } from "react";

export function QrCredentialInput({
  onValue,
}: {
  onValue: (value: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decodeImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      onValue(result.getText());
    } catch {
      setError("未能从图片识别二维码");
    } finally {
      URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <label className={secondaryButton}>
        {busy ? (
          <LoaderCircle className="animate-spin" aria-hidden="true" size={16} />
        ) : (
          <ImageUp aria-hidden="true" size={16} />
        )}
        从二维码图片导入
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(event) => void decodeImage(event)}
          className="sr-only"
        />
      </label>
      {error ? (
        <p className="mt-2 text-sm text-[var(--danger)]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const secondaryButton =
  "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
