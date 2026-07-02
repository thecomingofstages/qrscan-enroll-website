import { promises as fs } from "node:fs";
import path from "node:path";

type EventEntry = {
  event_id: string;
  activity_name: string;
};

type EventsFile = {
  events: EventEntry[];
};

let cached: { data: EventsFile; mtimeMs: number } | null = null;

async function loadEvents(): Promise<EventsFile> {
  const filePath = path.join(process.cwd(), "data", "events.json");
  const stat = await fs.stat(filePath);

  // Refresh the in-memory cache whenever the file changes on disk.
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.data;
  }

  const raw = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(raw) as EventsFile;
  cached = { data: parsed, mtimeMs: stat.mtimeMs };
  return parsed;
}

export async function GET() {
  try {
    const { events } = await loadEvents();
    return Response.json(events);
  } catch (error) {
    console.error("Failed to load events.json:", error);
    return Response.json(
      { error: "Failed to load events", details: String(error) },
      { status: 500 },
    );
  }
}
