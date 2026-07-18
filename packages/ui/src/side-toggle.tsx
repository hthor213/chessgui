"use client"

// Shared White/Black segmented toggle (spec 219 orientation): one control for
// "which side" wherever the user names their color — the active-game setup
// dialog's "I'm playing" and the active-games panel's per-game migration
// control. Emits on every click; the caller owns the value.

export function SideToggle({
  value,
  onChange,
  testId,
  size = "sm",
}: {
  value: "white" | "black"
  onChange: (color: "white" | "black") => void
  /** When set, the wrapper gets this id and each button `${testId}-${color}`. */
  testId?: string
  size?: "sm" | "md"
}) {
  const pad = size === "md" ? "px-3 py-1" : "px-2 py-0.5"
  return (
    <span
      className="inline-flex w-fit rounded border border-[#3a3835] overflow-hidden"
      data-testid={testId}
    >
      {(["white", "black"] as const).map((color) => (
        <button
          key={color}
          type="button"
          data-testid={testId ? `${testId}-${color}` : undefined}
          aria-pressed={value === color}
          onClick={() => onChange(color)}
          className={`${pad} text-xs capitalize transition-colors ${
            value === color
              ? "bg-amber-600 text-white"
              : "bg-[#2a2825] text-[#bababa] hover:bg-[#3a3835]"
          }`}
        >
          {color}
        </button>
      ))}
    </span>
  )
}
