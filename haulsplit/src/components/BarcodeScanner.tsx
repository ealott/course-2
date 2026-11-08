import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "../ui";

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf"];

/** Uses the browser's built-in BarcodeDetector where it exists (Android Chrome), else a WebAssembly one (iPhone). */
async function createDetector(): Promise<Detector> {
  const Native = (window as unknown as { BarcodeDetector?: any }).BarcodeDetector;
  if (Native) {
    try {
      const supported: string[] = await Native.getSupportedFormats();
      const formats = FORMATS.filter((f) => supported.includes(f));
      if (formats.length) return new Native({ formats });
    } catch {
      /* fall through to the WebAssembly version */
    }
  }
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import("barcode-detector/ponyfill"),
    import("zxing-wasm/reader/zxing_reader.wasm?url"),
  ]);
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
  });
  return new BarcodeDetector({ formats: FORMATS as any }) as unknown as Detector;
}

export function BarcodeScanner({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState("Starting camera…");
  const [manual, setManual] = useState("");
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let cancelled = false;

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no-camera");
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return;
        const el = video.current!;
        el.srcObject = stream;
        await el.play();
        setMessage("Point the camera at the barcode");
        const detector = await createDetector();
        const scan = async () => {
          if (cancelled || done.current) return;
          try {
            if (el.readyState >= 2) {
              const found = await detector.detect(el);
              const code = found.find((f) => f.rawValue)?.rawValue;
              if (code && !done.current) {
                done.current = true;
                navigator.vibrate?.(60);
                onDetected(code);
                return;
              }
            }
          } catch {
            /* frame not ready; keep trying */
          }
          timer = window.setTimeout(scan, 180);
        };
        void scan();
      } catch (err) {
        const name = (err as DOMException)?.name;
        setMessage(
          name === "NotAllowedError"
            ? "Camera access was blocked. Allow it in your browser settings, or type the number below."
            : "Couldn't open the camera here. Type the number under the barcode instead.",
        );
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDetected]);

  function submitManual(e: FormEvent) {
    e.preventDefault();
    const code = manual.replace(/\s/g, "");
    if (code.length >= 4) {
      done.current = true;
      onDetected(code);
    }
  }

  return (
    <div className="scanner" role="dialog" aria-label="Scan a barcode">
      <video ref={video} playsInline muted />
      <div className="scanner-frame" />
      <button
        className="icon-btn"
        aria-label="Close scanner"
        onClick={onClose}
        style={{ position: "absolute", top: "calc(env(safe-area-inset-top) + 10px)", right: 10, color: "#fff", background: "rgb(0 0 0 / 45%)" }}
      >
        <Icon name="x" size={24} />
      </button>
      <div className="scanner-bar">
        <p style={{ fontWeight: 600, textAlign: "center" }}>{message}</p>
        <form className="row" onSubmit={submitManual}>
          <input
            className="input grow"
            inputMode="numeric"
            placeholder="Or type the barcode number"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            aria-label="Barcode number"
          />
          <button className="btn primary" disabled={manual.replace(/\s/g, "").length < 4}>
            Look up
          </button>
        </form>
      </div>
    </div>
  );
}
