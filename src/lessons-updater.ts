const LESSONS_FILE = "src/data/lessons.json";

interface GapLesson {
  gapId: string;
  failure: string;
  lesson: string;
  updatedAt: string;
}

interface LessonsData {
  [gapId: string]: {
    [failure: string]: GapLesson;
  };
}

async function loadLessons(): Promise<LessonsData> {
  try {
    const raw = await Bun.file(LESSONS_FILE).text();
    return JSON.parse(raw) as LessonsData;
  } catch {
    return {};
  }
}

async function saveLessons(data: LessonsData): Promise<void> {
  await Bun.write(LESSONS_FILE, JSON.stringify(data, null, 2) + "\n");
}

async function updatePerGapFailureLessons() {
  const lessons = await loadLessons();

  // Example update: ensure a lesson exists for a specific gap and failure
  const targetGap = "per-gap failure lessons updated";
  const targetFailure = "semantic_gate_reject";
  const now = new Date().toISOString();

  if (!lessons[targetGap]) lessons[targetGap] = {};
  lessons[targetGap][targetFailure] = {
    gapId: targetGap,
    failure: targetFailure,
    lesson: "Review semantic gate feedback and adjust implementation to address live execution path requirements.",
    updatedAt: now,
  };

  await saveLessons(lessons);
}

updatePerGapFailureLessons()
  .then(() => console.log("Per-gap failure lessons updated successfully."))
  .catch((err) => {
    console.error("Failed to update lessons:", err);
    process.exit(1);
  });
