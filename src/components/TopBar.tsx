import { fsSupported } from '../lib/fsaccess';
import { openSheet, reconnectArchive, setView, useApp } from '../state/store';
import { Icon, Logo } from './Icon';
import { IconButton, Segmented, StatusDot } from './ui';

function ArchivePill() {
  const archive = useApp((s) => s.archive);
  const pending = archive.pending;
  let tone: 'ok' | 'warn' | 'off' | 'error' = 'off';
  let label = 'Browser storage';
  let title = 'Photos are kept in this browser. Connect an archive folder in Settings to also save files to disk.';
  if (archive.status === 'connected') {
    tone = 'ok';
    label = archive.name ?? 'Archive';
    title = `Every photo is also written to the “${archive.name}” folder.`;
  } else if (archive.status === 'needs-permission') {
    tone = 'warn';
    label = 'Reconnect archive';
    title = 'The browser needs your permission again to write to the archive folder. Click to allow.';
  } else if (archive.status === 'error') {
    tone = 'error';
    label = 'Archive unavailable';
    title = 'The archive folder could not be written. Photos are safe in the browser and will sync when it’s back.';
  } else if (!fsSupported) {
    title = 'This browser can’t write to folders. Use Chrome or Edge for archive folders.';
  }

  const onClick = () => {
    if (archive.status === 'needs-permission' || archive.status === 'error') void reconnectArchive();
    else openSheet({ type: 'settings' });
  };

  return (
    <button type="button" className={`pill pill-${tone}`} onClick={onClick} title={title}>
      <StatusDot tone={tone} />
      <Icon name="archive" size={15} />
      <span className="pill-label">{label}</span>
      {pending > 0 && archive.status !== 'none' && archive.status !== 'unsupported' && <span className="pill-count">{pending} to sync</span>}
    </button>
  );
}

export function TopBar() {
  const view = useApp((s) => s.view);
  const clinic = useApp((s) => s.settings.clinicName);
  return (
    <header className="topbar">
      <div className="brand">
        <Logo size={26} />
        <span className="brand-name">Lumen</span>
        <span className="brand-sep" aria-hidden="true" />
        <span className="brand-clinic">{clinic || 'Slit Lamp Imaging'}</span>
      </div>

      <Segmented
        ariaLabel="View"
        className="topbar-views"
        value={view}
        onChange={setView}
        options={[
          { value: 'capture', label: <><Icon name="camera" size={16} />Capture</>, title: 'Capture (V)' },
          { value: 'review', label: <><Icon name="grid" size={16} />Review</>, title: 'Review (V)' },
        ]}
      />

      <div className="topbar-right">
        <ArchivePill />
        <IconButton icon="keyboard" label="Keyboard shortcuts (?)" onClick={() => openSheet({ type: 'shortcuts' })} />
        <IconButton icon="sliders" label="Settings" onClick={() => openSheet({ type: 'settings' })} />
      </div>
    </header>
  );
}
