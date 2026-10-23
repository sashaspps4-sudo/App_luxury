import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { Minus, Square, X } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "glass" | "primary" | "icon";
  compact?: boolean;
};

export function GlassButton({ className = "", variant = "glass", compact = false, ...props }: GlassButtonProps) {
  const variantClass = variant === "primary" ? "primary-button" : variant === "icon" ? "glass-icon" : "glass-button";
  return <button className={`${variantClass} ${compact ? "small" : ""} ${className}`.trim()} {...props} />;
}

type PanelProps = HTMLAttributes<HTMLElement> & { children: ReactNode };

export function Panel({ className = "", children, ...props }: PanelProps) {
  return <section className={`panel-surface ${className}`.trim()} {...props}>{children}</section>;
}

async function runWindowAction(action: "minimize" | "maximize" | "close") {
  if (!isTauri()) return;
  const appWindow = getCurrentWindow();
  if (action === "minimize") await appWindow.minimize();
  if (action === "maximize") await appWindow.toggleMaximize();
  if (action === "close") await appWindow.close();
}

export function WindowChrome() {
  return (
    <div className="window-chrome" data-tauri-drag-region onDoubleClick={() => void runWindowAction("maximize")}>
      <div className="window-chrome-brand" data-tauri-drag-region>
        <span className="chrome-mark" />
        <span data-tauri-drag-region>Luxury Mailer</span>
      </div>
      <div className="window-controls">
        <button aria-label="Свернуть окно" onClick={() => void runWindowAction("minimize")}><Minus size={15} /></button>
        <button aria-label="Развернуть окно" onClick={() => void runWindowAction("maximize")}><Square size={12} /></button>
        <button className="close" aria-label="Закрыть окно" onClick={() => void runWindowAction("close")}><X size={15} /></button>
      </div>
    </div>
  );
}
