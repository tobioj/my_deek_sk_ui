"use client";
// Before/after view of a file change: removed lines in red, added lines in green.
import clsx from "clsx";
import type { DiffPreview } from "@/lib/types";

export function DiffView({ diff, maxHeight = "max-h-80" }: { diff: DiffPreview; maxHeight?: string }) {
  return (
    <div className={clsx("overflow-auto bg-code font-mono text-[12px] leading-[1.55]", maxHeight)}>
      {diff.hunks.map((h, hi) => {
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        return (
          <div key={hi} className={hi > 0 ? "border-t border-dashed border-line" : ""}>
            {h.lines.map((line, li) => {
              const sign = line[0];
              const text = line.slice(1);
              const left = sign === "+" ? "" : oldNo++;
              const right = sign === "-" ? "" : newNo++;
              return (
                <div
                  key={li}
                  className={clsx(
                    "flex min-w-max",
                    sign === "+" && "bg-green-500/12 text-green-800 dark:text-green-300",
                    sign === "-" && "bg-red-500/12 text-red-800 dark:text-red-300",
                  )}
                >
                  <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{left}</span>
                  <span className="w-10 shrink-0 select-none pr-2 text-right text-faint">{right}</span>
                  <span className="w-4 shrink-0 select-none text-center opacity-70">{sign === " " ? "" : sign}</span>
                  <span className="whitespace-pre pr-4">{text || " "}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      {diff.hunks.length === 0 && <div className="px-3 py-2 text-faint">(empty file)</div>}
      {diff.truncated && <div className="border-t border-line px-3 py-1.5 text-faint">… preview cut off (the full change will still be applied)</div>}
    </div>
  );
}
