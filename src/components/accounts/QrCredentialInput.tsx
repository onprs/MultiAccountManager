"use client";

import { Camera, CameraOff, ImageUp, LoaderCircle } from "lucide-react";
import { ChangeEvent, useEffect, useRef, useState } from "react";
import type { IScannerControls } from "@zxing/browser";

export function QrCredentialInput({
  onValue,
}: {
  onValue: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controlsRef.current?.stop(), []);

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

  async function startCamera() {
    if (!videoRef.current) return;
    setBusy(true);
    setError(null);
    setCameraActive(true);
    try {
      const { BrowserQRCodeReader } = await import("@zxing/browser");
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromVideoDevice(
        undefined,
        videoRef.current,
        (result, _error, scannerControls) => {
          if (!result) return;
          onValue(result.getText());
          scannerControls.stop();
          controlsRef.current = null;
          setCameraActive(false);
        },
      );
      controlsRef.current = controls;
    } catch {
      setCameraActive(false);
      setError("无法启动摄像头或未识别到二维码");
    } finally {
      setBusy(false);
    }
  }

  function stopCamera() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setCameraActive(false);
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <label className={secondaryButton}>
          {busy && !cameraActive ? <LoaderCircle className="animate-spin" aria-hidden="true" size={16} /> : <ImageUp aria-hidden="true" size={16} />}
          从图片识别
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void decodeImage(event)} className="sr-only" />
        </label>
        {cameraActive ? (
          <button type="button" onClick={stopCamera} className={secondaryButton}><CameraOff aria-hidden="true" size={16} />停止摄像头</button>
        ) : (
          <button type="button" disabled={busy} onClick={() => void startCamera()} className={secondaryButton}><Camera aria-hidden="true" size={16} />摄像头扫码</button>
        )}
      </div>
      <video ref={videoRef} muted playsInline className={`${cameraActive ? "mt-3 block" : "hidden"} aspect-video w-full max-w-lg bg-black object-cover`} />
      {error ? <p className="mt-2 text-sm text-[var(--danger)]" role="alert">{error}</p> : null}
    </div>
  );
}

const secondaryButton = "inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-[6px] border border-[var(--border)] bg-white px-4 font-semibold text-[var(--foreground)] hover:bg-[var(--surface-subtle)] disabled:cursor-not-allowed disabled:opacity-50";
