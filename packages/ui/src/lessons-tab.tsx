"use client"

// Concept Lessons — the Lessons surface (specs/227, D3).
//
// The list→detail→player flow, modelled on training-tab.tsx: an internal `view`
// switches course list → module list (with progress badges) → module player.
// Progress is the D2 append-only store, persisted through the StorageProvider
// seam under one key.
//
// Fair-play boundary (spec 227 D5): this file imports ONLY @chessgui/core lesson
// modules, the platform storage seam, and the module player (which itself only
// pulls the shared Board). It NEVER imports useChessGame, the notebook, the live
// game tree, or any active-game state — the boundary is structural. The surface
// is reachable and fully functional with no game loaded.

import { useState, useEffect, useCallback } from "react"
import { getProviders } from "@/lib/platform"
import { Card } from "@chessgui/ui/ui/card"
import { Button } from "@chessgui/ui/ui/button"
import { Badge } from "@chessgui/ui/ui/badge"
import { ScrollArea } from "@chessgui/ui/ui/scroll-area"
import { loadCourse, type Course, type Module } from "@chessgui/core/lessons"
import {
  parseLessonProgress,
  serializeLessonProgress,
  appendProgress,
  emptyProgress,
  resumePoint,
  type LessonProgressStore,
} from "@chessgui/core/lesson-progress"
import type { ModuleScore, SelfGrade } from "@chessgui/core/lesson-grade"
import { LessonModulePlayer } from "@chessgui/ui/lesson-module-player"
import fixtureCourse from "@chessgui/core/lessons/fixture-course.json"
import closedPositions from "@chessgui/core/lessons/closed-positions.json"

const PROGRESS_KEY = "chessgui-lesson-progress"

// Bundled courses. "Playing Closed & Locked Positions" (D4) is the primary
// shipped course; the fixture stays loaded (harmless) for the surface's own
// verification. New courses are added as JSON to this list — no code change to
// the player, per the data-driven contract.
const COURSES: Course[] = [loadCourse(closedPositions), loadCourse(fixtureCourse)]

type View = "courses" | "modules" | "player"

/** The latest progress entry for a module, if any. */
function latestEntry(store: LessonProgressStore, courseId: string, moduleId: string) {
  for (let i = store.entries.length - 1; i >= 0; i--) {
    const e = store.entries[i]
    if (e.courseId === courseId && e.moduleId === moduleId) return e
  }
  return null
}

export function LessonsTab({ initialView = "courses" }: { initialView?: View }) {
  const [view, setView] = useState<View>(initialView)
  const [courseIndex, setCourseIndex] = useState(0)
  const [moduleIndex, setModuleIndex] = useState(0)
  const [progress, setProgress] = useState<LessonProgressStore>(emptyProgress)

  // Resume-on-mount: read + parse the store, guarding malformed data (parse
  // throws — mirror calibration-tab.tsx's ignore-corrupt pattern).
  useEffect(() => {
    try {
      const raw = getProviders().storage.get(PROGRESS_KEY)
      setProgress(parseLessonProgress(raw))
    } catch {
      /* malformed store — start fresh, never crash the surface */
    }
  }, [])

  const course = COURSES[courseIndex]

  const persist = useCallback((next: LessonProgressStore) => {
    setProgress(next)
    getProviders().storage.set(PROGRESS_KEY, serializeLessonProgress(next))
  }, [])

  const onModuleComplete = useCallback(
    (module: Module, mIndex: number, score: ModuleScore) => {
      const questionScores = score.outcomes.map((o) =>
        o.countsTowardScore ? o.result.correct === true : null,
      )
      const freeTextSelfGrades: (SelfGrade | null)[] = score.outcomes.map((o) => o.selfGrade)
      const next = appendProgress(progress, {
        at: new Date().toISOString(),
        courseId: course.id,
        moduleId: module.id,
        moduleIndex: mIndex,
        questionIndex: Math.max(0, module.questions.length - 1),
        completed: true,
        score: score.score,
        total: score.total,
        questionScores,
        freeTextSelfGrades,
      })
      persist(next)
    },
    [progress, course, persist],
  )

  // ── Player ──────────────────────────────────────────────────────────────
  if (view === "player") {
    const module = course.modules[moduleIndex]
    return (
      <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
        <LessonModulePlayer
          module={module}
          onExit={() => setView("modules")}
          onComplete={(score) => onModuleComplete(module, moduleIndex, score)}
        />
      </div>
    )
  }

  // ── Module list ───────────────────────────────────────────────────────────
  if (view === "modules") {
    return (
      <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6" data-testid="lessons-module-list">
        <button
          onClick={() => setView("courses")}
          className="text-sm text-muted-foreground hover:text-foreground self-start"
        >
          ← All courses
        </button>
        <h2 className="text-xl font-semibold mt-2">{course.title}</h2>
        <p className="text-sm text-muted-foreground mb-4">{course.blurb}</p>
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col gap-2 max-w-2xl">
            {course.modules.map((m, i) => {
              const entry = latestEntry(progress, course.id, m.id)
              return (
                <Card
                  key={m.id}
                  className="bg-card/50 border-white/10 p-4 flex items-center gap-4 cursor-pointer hover:border-white/30 transition-colors"
                  data-testid={`lessons-module-${m.id}`}
                  onClick={() => {
                    setModuleIndex(i)
                    setView("player")
                  }}
                >
                  <span className="text-lg font-semibold text-muted-foreground w-6">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {m.illustrations.length} game{m.illustrations.length === 1 ? "" : "s"} ·{" "}
                      {m.questions.length} question{m.questions.length === 1 ? "" : "s"}
                    </div>
                  </div>
                  {entry?.completed ? (
                    <Badge variant="default" data-testid="lessons-module-badge-done">
                      {entry.score}/{entry.total}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Not started</Badge>
                  )}
                </Card>
              )
            })}
          </div>
        </ScrollArea>
      </div>
    )
  }

  // ── Course list ───────────────────────────────────────────────────────────
  return (
    <div className="flex-1 min-h-0 flex flex-col p-4 md:p-6" data-testid="lessons-course-list">
      <h2 className="text-xl font-semibold">Lessons</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Principle → illustrate → practice. Learn a concept, watch it on a master game, then drill it.
      </p>
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 max-w-2xl">
          {COURSES.map((c, i) => {
            const done = progress.entries.filter(
              (e) => e.courseId === c.id && e.completed,
            )
            const completedIds = new Set(done.map((e) => e.moduleId))
            const rp = resumePoint(progress, c.id)
            return (
              <Card
                key={c.id}
                className="bg-card/50 border-white/10 p-5 cursor-pointer hover:border-white/30 transition-colors"
                data-testid={`lessons-course-${c.id}`}
                onClick={() => {
                  setCourseIndex(i)
                  setView("modules")
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold text-foreground">{c.title}</h3>
                  <Badge variant="outline" className="capitalize">
                    {c.level}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{c.blurb}</p>
                <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
                  <span>{c.modules.length} modules</span>
                  <span>·</span>
                  <span>
                    {completedIds.size}/{c.modules.length} completed
                  </span>
                  {rp && (
                    <span className="text-emerald-400">
                      · Resume: {c.modules[rp.moduleIndex]?.title ?? "module"}
                    </span>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
