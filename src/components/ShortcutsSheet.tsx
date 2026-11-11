import { closeSheet, useApp } from '../state/store';
import { Kbd, Modal, SheetHeader } from './ui';

const GROUPS: { title: string; keys: [string[], string][] }[] = [
  {
    title: 'Capture',
    keys: [
      [['Space'], 'Take a photo (or your foot switch key)'],
      [['R'], 'Right eye (OD)'],
      [['L'], 'Left eye (OS)'],
      [['B'], 'Both eyes (OU)'],
      [['1', '–', '8'], 'Illumination technique'],
      [['0'], 'Clear technique'],
      [['D'], 'Diagnosis for today’s photos'],
      [['G'], 'Centring reticle'],
      [['F'], 'Full-screen live view'],
    ],
  },
  {
    title: 'Navigate',
    keys: [
      [['↑', '↓'], 'Previous / next patient'],
      [['/'], 'Find a patient on the list'],
      [['Ctrl', 'K'], 'Search every photograph'],
      [['V'], 'Switch Capture / Review'],
      [['?'], 'This list'],
    ],
  },
  {
    title: 'Viewer',
    keys: [
      [['←', '→'], 'Previous / next photo'],
      [['S'], 'Star'],
      [['A'], 'Annotate: circle, arrow, pen, text'],
      [['M'], 'Show / hide marks'],
      [['I'], 'Details'],
      [['Del'], 'Delete (with undo)'],
      [['Scroll'], 'Zoom; double-click for 1:1'],
      [['Esc'], 'Close'],
    ],
  },
];

export function ShortcutsSheet() {
  const open = useApp((s) => s.sheet?.type === 'shortcuts');
  return (
    <Modal open={open} onClose={closeSheet} width={640} labelledBy="keys-title">
      <SheetHeader id="keys-title" title="Keyboard shortcuts" subtitle="Most USB foot switches can be set to send Space — or bind any key in Settings." onClose={closeSheet} />
      <div className="keys-grid">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h3>{g.title}</h3>
            <dl>
              {g.keys.map(([k, label]) => (
                <div key={label} className="key-row">
                  <dt>
                    {k.map((x, i) => (x === '–' ? <span key={i} className="muted">–</span> : <Kbd key={i}>{x}</Kbd>))}
                  </dt>
                  <dd>{label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
