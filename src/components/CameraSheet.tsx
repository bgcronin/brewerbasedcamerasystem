import { useEffect } from 'react';
import { kindLabel, mediaSupported, type CameraKind } from '../lib/camera';
import { fsSupported } from '../lib/fsaccess';
import type { Settings } from '../lib/types';
import { useCamera } from '../state/camera';
import { chooseTetherFolder, closeSheet, startTether, stopTether, updateSettings, useApp } from '../state/store';
import { Icon, type IconName } from './Icon';
import { Button, Modal, Segmented, SheetHeader, StatusDot, cx } from './ui';

const KIND_ICON: Record<CameraKind, IconName> = { cso: 'eye', canon: 'camera', capture: 'monitor', generic: 'usb' };

export function CameraSheet() {
  const open = useApp((s) => s.sheet?.type === 'camera');
  const settings = useApp((s) => s.settings);
  const tether = useApp((s) => s.tether);
  const devices = useCamera((s) => s.devices);
  const status = useCamera((s) => s.status);
  const activeId = useCamera((s) => s.deviceId);
  const error = useCamera((s) => s.error);
  const info = useCamera((s) => s.info);

  useEffect(() => {
    if (open) void useCamera.getState().refreshDevices();
  }, [open]);

  const chooseLive = async (deviceId: string) => {
    stopTether();
    await updateSettings({ source: 'live', deviceId });
    const ok = await useCamera.getState().start(deviceId, settings.resolution);
    if (ok) closeSheet();
  };

  const chooseTether = async () => {
    useCamera.getState().stop();
    if (tether.name) {
      await updateSettings({ source: 'tether' });
      await startTether();
    } else {
      await chooseTetherFolder();
    }
    if (useApp.getState().tether.watching) closeSheet();
  };

  const setResolution = async (resolution: Settings['resolution']) => {
    await updateSettings({ resolution });
    if (settings.source === 'live' && status === 'live') await useCamera.getState().start(activeId, resolution);
  };

  return (
    <Modal open={open} onClose={closeSheet} width={600} labelledBy="camera-title">
      <SheetHeader id="camera-title" title="Camera source" subtitle="Choose how photographs reach Lumen." onClose={closeSheet} />
      <div className="sheet-body">
        <section className="source-section">
          <div className="source-section-head">
            <h3>Live cameras</h3>
            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void useCamera.getState().refreshDevices()} disabled={!mediaSupported}>
              Refresh
            </Button>
          </div>
          <p className="section-note">The CSO Mizar, a Canon in EOS Webcam Utility, or an HDMI capture card. Capture with Space or a foot switch.</p>
          {!mediaSupported ? (
            <p className="section-warning">This browser can’t use cameras. Open Lumen in Chrome or Edge.</p>
          ) : devices.length ? (
            <div className="source-list">
              {devices.map((d) => {
                const on = settings.source === 'live' && status === 'live' && d.deviceId === activeId;
                return (
                  <button key={d.deviceId} type="button" className={cx('source-card', on && 'is-on')} onClick={() => void chooseLive(d.deviceId)}>
                    <span className="source-card-icon">
                      <Icon name={KIND_ICON[d.kind]} size={20} />
                    </span>
                    <span className="source-card-text">
                      <strong>{d.label}</strong>
                      <span>
                        {kindLabel(d.kind)}
                        {on && info && ` · ${info.width}×${info.height}`}
                        {on && info?.maxWidth && info.maxWidth > info.width && ` (up to ${info.maxWidth}×${info.maxHeight})`}
                      </span>
                    </span>
                    {on ? <StatusDot tone="live" /> : <Icon name="chevronRight" size={16} />}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="section-note muted">No cameras found yet. Connect the camera’s USB cable, then press Refresh. The browser will ask for permission the first time.</p>
          )}
          {error && status === 'error' && <p className="section-warning">{error}</p>}
          <div className="source-res">
            <span>Resolution</span>
            <Segmented<Settings['resolution']>
              size="sm"
              value={settings.resolution}
              onChange={(v) => void setResolution(v)}
              options={[
                { value: 'auto', label: 'Maximum' },
                { value: '3840x2160', label: '4K' },
                { value: '2560x1440', label: '1440p' },
                { value: '1920x1080', label: '1080p' },
                { value: '1280x720', label: '720p' },
              ]}
            />
          </div>
        </section>

        <section className="source-section">
          <div className="source-section-head">
            <h3>Canon EOS · full resolution</h3>
          </div>
          <p className="section-note">
            Tether the Canon with EOS Utility’s <em>Remote Shooting</em> and set its destination folder. Lumen watches that folder and files each shot to the selected patient and eye the moment it lands. This also works with any program that saves photos to a folder, such as CSO Phoenix.
          </p>
          <button
            type="button"
            className={cx('source-card', settings.source === 'tether' && tether.watching && 'is-on')}
            onClick={() => void chooseTether()}
            disabled={!fsSupported}
          >
            <span className="source-card-icon">
              <Icon name="folder" size={20} />
            </span>
            <span className="source-card-text">
              <strong>{tether.name ? `Watch “${tether.name}”` : 'Choose the EOS Utility folder…'}</strong>
              <span>
                {!fsSupported
                  ? 'Requires Chrome or Edge'
                  : settings.source === 'tether' && tether.watching
                    ? 'Watching for new photos'
                    : tether.status === 'needs-permission'
                      ? 'Click to allow access again'
                      : 'Folder watch · JPEG at full sensor resolution'}
              </span>
            </span>
            {settings.source === 'tether' && tether.watching ? <StatusDot tone="live" /> : <Icon name="chevronRight" size={16} />}
          </button>
          {tether.name && fsSupported && (
            <button type="button" className="link-btn source-change" onClick={() => void chooseTetherFolder()}>
              Use a different folder
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}
