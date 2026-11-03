import { useEffect, useState, type FormEvent } from 'react';
import { getPatient, getVisit } from '../lib/db';
import type { Patient } from '../lib/types';
import { closeSheet, removeFromList, savePatient, toast, useApp, type PatientForm } from '../state/store';
import { Button, Field, Modal, Segmented, SheetHeader } from './ui';

const EMPTY: PatientForm = { mrn: '', firstName: '', lastName: '', dob: '', sex: '', notes: '', time: '', clinic: '', reason: '' };

export function PatientSheet() {
  const sheet = useApp((s) => s.sheet);
  const open = sheet?.type === 'patient';
  const patientId = open ? sheet.patientId : undefined;
  const visitId = open ? sheet.visitId : undefined;
  const [form, setForm] = useState<PatientForm>(EMPTY);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    if (!patientId) return;
    void Promise.all([getPatient(patientId), visitId ? getVisit(visitId) : undefined]).then(([p, v]) => {
      if (!p) return;
      setForm({
        mrn: p.mrn,
        firstName: p.firstName,
        lastName: p.lastName,
        dob: p.dob ?? '',
        sex: p.sex ?? '',
        notes: p.notes ?? '',
        time: v?.time ?? '',
        clinic: v?.clinic ?? '',
        reason: v?.reason ?? '',
      });
    });
  }, [open, patientId, visitId]);

  const set = <K extends keyof PatientForm>(k: K, v: PatientForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.lastName.trim() && !form.firstName.trim()) {
      toast({ tone: 'warning', message: 'Add the patient’s name' });
      return;
    }
    setBusy(true);
    try {
      await savePatient(
        { ...form, mrn: form.mrn.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim(), dob: form.dob || undefined },
        patientId,
        visitId,
      );
      toast({ tone: 'success', message: patientId ? 'Patient updated' : 'Patient added to the list' });
      closeSheet();
    } catch (err) {
      toast({ tone: 'error', message: 'Couldn’t save', detail: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={closeSheet} width={560} labelledBy="patient-title">
      <SheetHeader id="patient-title" title={patientId ? 'Edit patient' : 'Add patient'} subtitle={patientId ? undefined : 'Added to the list for the day you’re viewing.'} onClose={closeSheet} />
      <form className="form" onSubmit={(e) => void submit(e)}>
        <div className="form-grid">
          <Field label="Surname">
            <input className="input" value={form.lastName} onChange={(e) => set('lastName', e.target.value)} autoComplete="off" data-autofocus />
          </Field>
          <Field label="First name">
            <input className="input" value={form.firstName} onChange={(e) => set('firstName', e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Patient ID / MRN">
            <input className="input input-mono" value={form.mrn} onChange={(e) => set('mrn', e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Date of birth">
            <input className="input" type="date" value={form.dob} onChange={(e) => set('dob', e.target.value)} max={new Date().toISOString().slice(0, 10)} />
          </Field>
          <Field label="Sex" wide>
            <Segmented<NonNullable<Patient['sex']>>
              value={form.sex ?? ''}
              onChange={(v) => set('sex', v)}
              options={[
                { value: 'F', label: 'Female' },
                { value: 'M', label: 'Male' },
                { value: 'O', label: 'Other' },
                { value: '', label: 'Not stated' },
              ]}
            />
          </Field>
          <Field label="Appointment time">
            <input className="input" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} />
          </Field>
          <Field label="Clinic">
            <input className="input" value={form.clinic} onChange={(e) => set('clinic', e.target.value)} placeholder="e.g. Cornea" />
          </Field>
          <Field label="Reason for visit" wide>
            <input className="input" value={form.reason} onChange={(e) => set('reason', e.target.value)} placeholder="e.g. Review – keratoconus" />
          </Field>
        </div>
        <footer className="sheet-foot">
          {visitId && (
            <Button
              variant="ghost"
              className="btn-danger-text"
              onClick={() => {
                void removeFromList(visitId).then(() => {
                  if (!useApp.getState().rows.some((r) => r.visit.id === visitId)) closeSheet();
                });
              }}
            >
              Remove from this day’s list
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={closeSheet}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {patientId ? 'Save' : 'Add patient'}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
