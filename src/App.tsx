import { useEffect, useState } from 'react';
import { CameraSheet } from './components/CameraSheet';
import { CaptureView } from './components/CaptureView';
import { CompareView } from './components/CompareView';
import { Icon } from './components/Icon';
import { ImportSheet } from './components/ImportSheet';
import { Inspector } from './components/Inspector';
import { Lightbox } from './components/Lightbox';
import { PatientSheet } from './components/PatientSheet';
import { ReviewView } from './components/ReviewView';
import { SettingsSheet } from './components/SettingsSheet';
import { ShortcutsSheet } from './components/ShortcutsSheet';
import { Toasts } from './components/Toasts';
import { TopBar } from './components/TopBar';
import { Worklist } from './components/Worklist';
import { handleDroppedFiles, onGlobalKeyDown, onGlobalKeyUp } from './state/actions';
import { importFiles, init, toast, useApp } from './state/store';

export function App() {
  const view = useApp((s) => s.view);
  const ready = useApp((s) => s.ready);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    init().catch((e: unknown) => {
      useApp.setState({ ready: true });
      toast({
        tone: 'error',
        message: 'Browser storage is unavailable',
        detail: `Photos can’t be saved. Use Chrome or Edge in a normal (not private) window. ${(e as Error)?.message ?? ''}`,
        duration: 60000,
      });
    });
    window.addEventListener('keydown', onGlobalKeyDown);
    window.addEventListener('keyup', onGlobalKeyUp);
    return () => {
      window.removeEventListener('keydown', onGlobalKeyDown);
      window.removeEventListener('keyup', onGlobalKeyUp);
    };
  }, []);

  // Drop a CSV anywhere to import a list; drop photos to add them to the current patient.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void handleDroppedFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className="app" data-view={view} data-ready={ready || undefined}>
      <TopBar />
      <Worklist />
      <main className="main">{view === 'capture' ? <CaptureView /> : <ReviewView />}</main>
      {view === 'capture' && <Inspector />}

      <Lightbox />
      <CompareView />
      <ImportSheet />
      <PatientSheet />
      <SettingsSheet />
      <CameraSheet />
      <ShortcutsSheet />
      <Toasts />
      <input
        id="add-photos-input"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        hidden
        onChange={(e) => {
          void importFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Icon name="import" size={28} />
            <strong>Drop to import</strong>
            <span>A CSV list adds patients · photos go to the selected patient</span>
          </div>
        </div>
      )}
    </div>
  );
}
