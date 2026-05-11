import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, X } from 'lucide-react';

// Custom dark title bar matching Option A. Replaces the OS chrome (the
// window is set decorations:false in tauri.conf.json). The bar is the
// drag region; the three buttons on the right control window state.

export function WindowChrome() {
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region
      className="flex h-[30px] shrink-0 items-center gap-2 bg-foreground px-2.5 text-[11px] text-background"
    >
      <div
        data-tauri-drag-region
        className="grid h-[14px] w-[14px] place-items-center rounded-sm bg-background text-[9px] font-bold text-foreground"
      >
        H
      </div>
      <span data-tauri-drag-region className="flex-1 select-none">
        Hindsight
      </span>
      <div className="flex">
        <ChromeButton onClick={() => void win.minimize()} title="Minimize">
          <Minus className="h-[11px] w-[11px]" />
        </ChromeButton>
        <ChromeButton onClick={() => void win.toggleMaximize()} title="Maximize">
          <Square className="h-[10px] w-[10px]" />
        </ChromeButton>
        <ChromeButton onClick={() => void win.close()} title="Close" danger>
          <X className="h-[11px] w-[11px]" />
        </ChromeButton>
      </div>
    </div>
  );
}

function ChromeButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={
        'grid h-[30px] w-[30px] place-items-center text-background/70 transition-colors ' +
        (danger ? 'hover:bg-destructive hover:text-white' : 'hover:bg-white/15')
      }
    >
      {children}
    </button>
  );
}
