"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

const palettes = [
  { id: "cobalt", name: "Cobalt", color: "#3861ed" },
  { id: "violet", name: "Violet", color: "#7954d4" },
  { id: "graphite", name: "Graphite", color: "#475569" },
  { id: "coral", name: "Coral", color: "#c6503e" },
] as const;
type Accent = (typeof palettes)[number]["id"];
const AccentContext = createContext<{
  accent: Accent;
  select: (value: Accent) => void;
}>({
  accent: "cobalt",
  select: () => {},
});

export function AccentTheme({ children }: { children: React.ReactNode }) {
  const [accent, setAccent] = useState<Accent>("cobalt");
  useEffect(() => {
    // A host cookie lets the local and public previews share the same choice.
    const restore = () => {
      const saved = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("tokensrank-accent="))
        ?.split("=")[1];
      if (palettes.some((palette) => palette.id === saved)) {
        setAccent(saved as Accent);
        document.documentElement.dataset.accent = saved;
      }
    };
    restore();
    window.addEventListener("focus", restore);
    return () => window.removeEventListener("focus", restore);
  }, []);

  function select(value: Accent) {
    setAccent(value);
    document.documentElement.dataset.accent = value;
    document.cookie = `tokensrank-accent=${value}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  return (
    <AccentContext.Provider value={{ accent, select }}>
      {children}
    </AccentContext.Provider>
  );
}

export function AccentPicker() {
  const { accent, select } = useContext(AccentContext);
  const menu = useRef<HTMLDetailsElement>(null);
  const selected = palettes.find((palette) => palette.id === accent)!;
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node))
        menu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  return (
    <details
      className="dash-palette"
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          menu.current?.removeAttribute("open");
          menu.current?.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={`Accent color: ${selected.name}`}>
        <i style={{ background: selected.color }} aria-hidden="true" />
        <span>{selected.name}</span>
        <ChevronDown size={12} />
      </summary>
      <div
        className="dash-palette-options"
        role="group"
        aria-label="Accent colors"
      >
        <p>Choose an accent</p>
        {palettes.map((palette) => (
          <button
            key={palette.id}
            type="button"
            aria-pressed={accent === palette.id}
            onClick={() => select(palette.id)}
          >
            <i style={{ background: palette.color }} aria-hidden="true" />
            {palette.name}
            {accent === palette.id && <Check size={14} />}
          </button>
        ))}
      </div>
    </details>
  );
}
