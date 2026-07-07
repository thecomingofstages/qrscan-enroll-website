"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeScannerState } from "html5-qrcode";

interface Activity {
  event_id: string;
  activity_name: string;
}

interface ScanData {
  registration_id?: string;
  status?: string;
  checked_in_at?: string;
  user?: Record<string, unknown>;
  activity_name?: string;
  date_key?: string;
  stamps?: unknown[];
  is_exchanged?: boolean;
}

interface ScanResponse {
  status: number;
  data?: ScanData & Record<string, unknown>;
  error?: string;
  message?: string;
  details?: unknown;
}

interface CameraInfo {
  id: string;
  label: string;
}

// Cooldown after a successful scan to keep the camera from firing the same
// QR again before the operator has had a chance to look at the result.
const RESCAN_COOLDOWN_MS = 2500;

// State-guarded teardown. `Html5Qrcode.stop()` and `.clear()` *throw
// synchronously* (not reject) when the scanner isn't in a state that allows
// them — which is exactly what happens on the first React StrictMode
// cleanup, before start() has resolved. This helper swallows those throws
// and never lets them escape as uncaught errors.
async function teardownScanner(scanner: Html5Qrcode): Promise<void> {
  try {
    const state = scanner.getState();
    if (
      state === Html5QrcodeScannerState.SCANNING ||
      state === Html5QrcodeScannerState.PAUSED
    ) {
      await scanner.stop();
    }
  } catch {
    // stop() failed (e.g. mid-initialisation); fall through to clear().
  }
  try {
    if (scanner.getState() === Html5QrcodeScannerState.NOT_STARTED) {
      scanner.clear();
    }
  } catch {
    // clear() can also throw on a half-initialised scanner; nothing else
    // we can safely do here.
  }
}

export default function Home() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>("");
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState<string>("");
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [scanResponse, setScanResponse] =
    useState<ScanResponse | null>(null);
  const [decodedText, setDecodedText] = useState<string | null>(null);
  const [exchangePending, setExchangePending] = useState(false);
  const [exchangeMessage, setExchangeMessage] = useState<string | null>(null);
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  // Tracks whether a scan is currently in flight so the QR callback can be a
  // no-op until the cooldown / restart completes.
  const scanInFlightRef = useRef(false);

  const selectedEventIdRef = useRef(selectedEventId);

  useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
  }, [selectedEventId]);

  // Load the local event list once on mount.
  useEffect(() => {
    const fetchActivities = async () => {
      try {
        const response = await fetch("/api/events");
        if (!response.ok) {
          throw new Error(`Failed to load events (${response.status})`);
        }
        const data = (await response.json()) as Activity[];
        setActivities(data);
        if (data.length > 0) {
          setSelectedEventId(data[0].event_id);
        }
      } catch (error) {
        console.error("Error loading events:", error);
        setCameraError(
          error instanceof Error
            ? error.message
            : "Could not load the event list.",
        );
      }
    };
    fetchActivities();
  }, []);

  // Open / re-open the camera whenever the chosen device changes.
  // The scanner is owned by this effect — the cleanup awaits stop()+clear()
  // so the next start() never races a still-running track.
  useEffect(() => {
    let scanner: Html5Qrcode | null = null;
    let cancelled = false;

    const startScanner = async () => {
      setCameraReady(false);
      setCameraError(null);

      try {
        scanner = new Html5Qrcode("qr-reader");
      } catch (error) {
        console.error("Scanner construction failed:", error);
        setCameraError("Unable to initialise the QR scanner.");
        return;
      }

      try {
        // Enumerate devices once we have permission (the prompt is triggered
        // by the start() call below). If multiple are reported, surface them
        // in the picker.
        const devices = await Html5Qrcode.getCameras().catch(() => []);
        if (cancelled) return;
        if (devices.length > 0) {
          setCameras(devices);
          // If the previously selected camera disappeared, fall back to the
          // first available device.
          setSelectedCameraId((current) => {
            if (current && devices.some((d) => d.id === current)) {
              return current;
            }
            return devices[0].id;
          });
        }

        const cameraConfig = selectedCameraId
          ? { deviceId: { exact: selectedCameraId } }
          : { facingMode: "environment" };

        await scanner.start(
          cameraConfig,
          {
            fps: 15,
            qrbox: { width: 320, height: 320 },
            aspectRatio: 1.0,
            disableFlip: false,
          },
          onScanSuccess,
          () => {
            // Per-frame decode failure — keep the stream open.
          },
        );

        if (cancelled) {
          await teardownScanner(scanner);
          return;
        }
        setCameraReady(true);
      } catch (error) {
        console.error("Camera init failed:", error);
        if (!cancelled) {
          setCameraError(
            "Unable to open the camera. Check browser permissions and reload.",
          );
        }
      }
    };

    startScanner();

    return () => {
      cancelled = true;
      if (!scanner) return;
      void teardownScanner(scanner);
    };
    // The scanner is restarted only when the selected camera changes. We
    // intentionally do not restart when the selected event changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCameraId]);

  const onScanSuccess = useCallback(
    async (decodedText: string) => {
      if (scanInFlightRef.current) return;

      setDecodedText(decodedText);
      setExchangeMessage(null);
      setExchangeError(null);
      scanInFlightRef.current = true;
      setSubmitting(true);

      console.log("QR Code scanned:", {
        decodedText,
        selectedEventId: selectedEventIdRef.current,
        isEventSelected: !!selectedEventIdRef.current,
      });

      try {
        const payload = {
          qr_token: decodedText,
          ...(selectedEventIdRef.current
            ? { event_id: selectedEventIdRef.current }
            : {}),
        };

        console.log("Sending scan request:", payload);

        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const body = (await response.json().catch(() => ({}))) as ScanResponse;
        const safeMessage =
          typeof body.message === "string"
            ? body.message
            : body.message != null
            ? JSON.stringify(body.message)
            : undefined;
        const safeError =
          typeof body.error === "string"
            ? body.error
            : body.error != null
            ? JSON.stringify(body.error)
            : undefined;
        const normalised: ScanResponse = {
          status: body.status ?? response.status,
          data: body.data,
          error: safeError,
          message: safeMessage,
          details: body.details,
        };
        setScanResponse(normalised);
      } catch (error) {
        setScanResponse({
          status: 0,
          error: "NetworkError",
          message:
            error instanceof Error
              ? error.message
              : "Network request failed.",
          details: null,
        });
      } finally {
        setSubmitting(false);
        // After a short pause, allow the next QR to be accepted.
        window.setTimeout(() => {
          scanInFlightRef.current = false;
        }, RESCAN_COOLDOWN_MS);
      }
    },
    [],
  );

  const handleMarkExchanged = useCallback(async () => {
    if (!decodedText) return;

    setExchangePending(true);
    setExchangeError(null);
    setExchangeMessage(null);

    try {
      const response = await fetch("/api/mark-exchanged", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qr_token: decodedText }),
      });

      const body = (await response.json().catch(() => ({}))) as {
        message?: unknown;
        error?: unknown;
      };

      if (!response.ok) {
        const message =
          typeof body.message === "string"
            ? body.message
            : typeof body.error === "string"
            ? body.error
            : "Unable to mark the stamp as exchanged.";
        throw new Error(message);
      }

      setExchangeMessage("Done");
      setScanResponse((current) =>
        current
          ? {
              ...current,
              data: {
                ...(current.data ?? {}),
                is_exchanged: true,
              },
            }
          : current,
      );
    } catch (error) {
      setExchangeError(
        error instanceof Error
          ? error.message
          : "Unable to mark the stamp as exchanged.",
      );
    } finally {
      setExchangePending(false);
    }
  }, [decodedText]);

  const userFields = scanResponse?.data?.user;
  const isSuccess =
    !!scanResponse && scanResponse.status >= 200 && scanResponse.status < 300;

  return (
    <main className="flex flex-col min-h-dvh max-h-dvh overflow-hidden p-3 gap-3 sm:p-6 sm:gap-6">

      <div className="flex flex-col gap-4">
        <div>
          <label className="block text-sm font-semibold text-yellow-400 mb-2">
            Select Event
          </label>
          <select
            value={selectedEventId}
            onChange={(e) => setSelectedEventId(e.target.value)}
            className="w-full px-4 py-2 bg-black text-white rounded focus:outline-none focus:border-yellow-400"
          >
            <option value="">-- Choose an event --</option>
            {activities.map((activity) => (
              <option key={activity.event_id} value={activity.event_id}>
                {activity.activity_name}
              </option>
            ))}
          </select>
          <p className="text-xs text-slate-400 mt-1">
            Leave empty for stamp-only mode.
          </p>
        </div>

        {cameras.length > 1 && (
          <div>
            <label className="block text-sm font-semibold text-yellow-400 mb-2">
              Camera
            </label>
            <select
              value={selectedCameraId}
              onChange={(e) => setSelectedCameraId(e.target.value)}
              className="w-full px-4 py-2 bg-gray-700 text-white border border-gray-500 rounded focus:outline-none focus:border-yellow-400"
            >
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>
                  {camera.label || `Camera ${camera.id.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex items-center justify-center">
        <div className="w-full max-w-2xl aspect-square bg-black rounded overflow-hidden">
          <div id="qr-reader" className="w-full h-full"></div>
        </div>
      </div>

      {cameraError && (
        <div className="p-4 rounded bg-red-700 text-white text-center">
          <p className="font-semibold">{cameraError}</p>
        </div>
      )}

      {!cameraReady && !cameraError && (
        <div className="p-4 rounded bg-gray-700 text-white text-center">
          <p>Opening camera…</p>
        </div>
      )}

      {submitting && (
        <div className="p-4 rounded bg-gray-700 text-white text-center">
          <p>Submitting scan…</p>
        </div>
      )}

      {decodedText && (
        <div className="p-4 rounded bg-slate-800 text-slate-100 text-sm">
          <p className="font-semibold">Detected QR content</p>
          <p className="mt-1 wrap-break-word">{decodedText}</p>
        </div>
      )}

      {scanResponse && !submitting && (
        <div
          className={`p-4 rounded text-white ${
            isSuccess ? "bg-green-700" : "bg-red-700"
          }`}
        >
          {isSuccess ? (
            <SuccessView
              result={scanResponse.data ?? {}}
              onMarkExchanged={handleMarkExchanged}
              exchangePending={exchangePending}
              exchangeMessage={exchangeMessage}
              exchangeError={exchangeError}
            />
          ) : (
            <ErrorView response={scanResponse} />
          )}
        </div>
      )}
    </main>
  );
}

function SuccessView({
  result,
  onMarkExchanged,
  exchangePending,
  exchangeMessage,
  exchangeError,
}: {
  result: ScanData & Record<string, unknown>;
  onMarkExchanged: () => void;
  exchangePending: boolean;
  exchangeMessage: string | null;
  exchangeError: string | null;
}) {
  const user = (result.user as Record<string, unknown> | undefined) ?? {};
  const displayedItems = [
    { label: "Registration ID", value: result.registration_id },
    { label: "Name", value: user.full_name },
    { label: "Nickname", value: user.nickname },
    { label: "Phone", value: user.phone },
    { label: "Checked In Time", value: result.checked_in_at },
  ];

  return (
    <div>
      <p className="font-semibold mb-3 text-lg">Checked In</p>
      <div className="space-y-2 text-sm">
        {displayedItems.map((item) => (
          <div key={item.label} className="flex items-start gap-3 rounded bg-black/20 p-2">
            <span className="w-32 shrink-0 text-gray-200">{item.label}</span>
            <span className="text-white break-all">{formatValue(item.value)}</span>
          </div>
        ))}
      </div>

      {!result.is_exchanged && (
        <div className="mt-4 border-t border-white/15 pt-3">
          <button
            type="button"
            onClick={onMarkExchanged}
            disabled={exchangePending}
            className="rounded bg-yellow-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-60"
          >
            {exchangePending ? "Updating..." : "Mark exchanged"}
          </button>
          {exchangeMessage && (
            <p className="mt-2 text-sm text-green-200">{exchangeMessage}</p>
          )}
          {exchangeError && (
            <p className="mt-2 text-sm text-red-100">{exchangeError}</p>
          )}
        </div>
      )}
    </div>
  );
}

function ErrorView({ response }: { response: ScanResponse }) {
  return (
    <div className="text-center">
      <p className="font-semibold text-lg">Scan failed</p>
      <p className="text-sm text-gray-100 mt-2">
        Message: {response.message ?? response.error ?? "Request failed"}
      </p>
      <p className="text-sm text-gray-200 mt-1">Status: {response.status}</p>
      {response.details !== undefined && response.details !== null && (
        <pre className="text-xs text-gray-100 mt-3 text-left whitespace-pre-wrap wrap-break-word">
          {formatValue(response.details)}
        </pre>
      )}
    </div>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
