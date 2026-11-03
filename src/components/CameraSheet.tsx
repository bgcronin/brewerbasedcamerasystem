import { useEffect } from 'react';
import { kindLabel, mediaSupported, type CameraKind } from '../lib/camera';
import { fsSupported } from '../lib/fsaccess';
import type { Settings } from '../lib/types';
import { useCamera } from '../state/camera';
import { reconnectLink, useCanon } from '../state/canon';
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
  const canonLink = useCanon((s) => s.link);
  const canonCam = useCanon((s) => s.camera);
  const helper = useCanon((s) => s.helper);

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

  const chooseCanon = async () => {
    useCamera.getState().stop();
    stopTether();
    await updateSettings({ source: 'canon' });
    if (canonLink === 'offline') reconnectLink();
    closeSheet();
  };

  const canonOn = settings.source === 'canon';
  const canonDetail =
    canonLink === 'online'
      ? canonCam?.state === 'connected'
        ? `Connected · live view, settings and presets${helper?.backend === 'simulator' ? ' · simulated camera' : ''}`
        : canonCam?.message ?? 'Camera Link is running · waiting for the camera'
      : canonOn
        ? 'Camera Link isn’t running on this computer yet'
        : 'Needs Lumen Camera Link running on this computer';

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
            <h3>Canon EOS · direct</h3>
            <span className="source-badge">Recommended</span>
          </div>
          <p className="section-note">
            Full control through Lumen Camera Link: live view, shutter from Lumen or the foot switch, and ISO, shutter speed, aperture and white balance with presets for each
            illumination.
          </p>
          <button type="button" className={cx('source-card', canonOn && canonCam?.state === 'connected' && 'is-on')} onClick={() => void chooseCanon()}>
            <span className="source-card-icon">
              <Icon name="camera" size={20} />
            </span>
            <span className="source-card-text">
              <strong>{canonCam?.state === 'connected' ? canonCam.model : 'Canon EOS via Camera Link'}</strong>
              <span>{canonDetail}</span>
            </span>
            {canonOn && canonCam?.state === 'connected' ? <StatusDot tone="live" /> : <Icon name="chevronRight" size={16} />}
          </button>
        </section>

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
            <h3>Folder watch · EOS Utility or CSO Phoenix</h3>
          </div>
          <p className="section-note">
            The fallback when Camera Link isn’t available. Point EOS Utility’s <em>Remote Shooting</em> (or CSO Phoenix) at a folder, and Lumen files each new photo to the selected patient and eye.
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
