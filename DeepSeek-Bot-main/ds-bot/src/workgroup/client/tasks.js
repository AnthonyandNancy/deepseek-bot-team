// The cards for work another person asked this machine to do (plan §10.1 step 3).
//
// Extracted from panel.js so BOTH places a person can reach can show them: the workgroup panel, and
// the group settings drawer. The drawer is the one that matters in practice — opening a workgroup
// goes through the original conversation view, and its gear opens the original settings, so a card
// that only existed inside the workgroup panel was a card nobody could answer.
//
// Behaviour is unchanged from the panel's version: only this group's waiting requests, only for the
// person they are addressed to (the host answers only with those), and every decision goes through
// `task-decide` so the approval is recorded against this device.
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { t } from '../../client/i18n.js'
import { callWorkgroup } from './api.js'

export function ApprovalCards({ onChanged }) {
  const [requests, setRequests] = useState([])
  const [active, setActive] = useState([])
  const [busy, setBusy] = useState(null)
  const [note, setNote] = useState(null)
  const [mode, setMode] = useState({})

  const load = useCallback(async () => {
    try {
      const answer = await callWorkgroup('task-requests')
      setRequests(answer.requests ?? [])
      setActive(answer.active ?? [])
    } catch {
      // Signed out or a Hub that is down. The connection line already says which.
      setRequests([])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (requests.length === 0 && active.length === 0) return null

  const decide = async (request, decision) => {
    setBusy(request.taskId)
    setNote(null)
    try {
      const choice = mode[request.taskId] ?? 'existingBot'
      await callWorkgroup('task-decide', {
        taskId: request.taskId,
        decision,
        mode: choice,
        // The Chief picking a Bot is a host-side decision; the button stays the same for the person.
        botId: choice === 'existingBot' ? 'a' : undefined,
      })
      await load()
      onChanged?.()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(null)
    }
  }

  // One card. Built as a variable rather than one long nested call: the version that was written as
  // a single expression had a missing paren, and a screen a person uses to GRANT WORK deserves to be
  // readable enough that the next person can check it.
  const cardFor = (request) => {
    const choice = mode[request.taskId] ?? 'existingBot'
    const scope = [...(request.resources ?? []), ...(request.capabilities ?? [])]
    const pending = busy === request.taskId
    return h('div', { key: request.taskId, className: 'bt-wg-task-row', 'data-task': request.taskId },
      h('div', { className: 'bt-wg-task-title' }, request.title || t('A task')),
      h('div', { className: 'bt-wg-task-meta' },
        [request.groupName || t('A workgroup'), request.requesterName].filter(Boolean).join(' · ')),
      // What was asked for, in the requester's own terms. Shown BEFORE the decision: a scope nobody
      // read is a scope nobody approved.
      scope.length === 0 ? null : h('div', { className: 'bt-wg-task-scope' }, scope.join(', ')),
      h('div', { className: 'bt-wg-task-actions' },
        h('select', {
          className: 'bt-input bt-wg-task-mode',
          'aria-label': t('Which Bot runs this'),
          value: choice,
          onChange: event => setMode({ ...mode, [request.taskId]: event.target.value }),
        },
        h('option', { value: 'existingBot' }, t('An existing Bot')),
        h('option', { value: 'chiefPicks' }, t('Let the Chief choose')),
        h('option', { value: 'newBot' }, t('A new Bot for this task'))),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: pending,
          onClick: () => void decide(request, 'granted'),
        }, t('Approve')),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: pending,
          onClick: () => void decide(request, 'rejected'),
        }, t('Decline'))))
  }

  // A task this machine already agreed to. It has a different set of actions from a card, and they
  // are the ones the plan's steps 5-7 name: start it, stop it, or finish it.
  const run = async (taskId, endpoint) => {
    setBusy(taskId)
    setNote(null)
    try {
      await callWorkgroup(endpoint, { taskId })
      await load()
      onChanged?.()
    } catch (error) {
      setNote(error?.message ?? String(error))
    } finally {
      setBusy(null)
    }
  }

  const runningFor = task => {
    const pendingRun = busy === task.taskId
    return h('div', { key: task.taskId, className: 'bt-wg-task-row', 'data-task': task.taskId, 'data-state': task.state },
      h('div', { className: 'bt-wg-task-title' }, task.title || t('A task')),
      h('div', { className: 'bt-wg-task-meta' }, `${task.state}${task.live ? '' : ` · ${t('no longer authorized')}`}`),
      h('div', { className: 'bt-wg-task-actions' },
        // "Start" is offered only while the ledger says the task may still run, so a stale card
        // cannot present an action the guard would refuse.
        task.state === 'APPROVED' && task.live
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pendingRun, onClick: () => void run(task.taskId, 'task-start') }, t('Start'))
          : null,
        task.state === 'RUNNING'
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: pendingRun, onClick: () => void run(task.taskId, 'task-finish') }, t('Finish'))
          : null,
        task.live
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-danger', disabled: pendingRun, onClick: () => void run(task.taskId, 'task-cancel') }, t('Stop'))
          : null,
        h('span', { className: 'bt-wg-task-meta' }, task.live ? '' : t('no longer authorized'))))
  }

  return h('div', { className: 'bt-wg-tasks', role: 'region', 'aria-label': t('Requests for you'), 'data-requests': String(requests.length), 'data-active': String(active.length) },
    h('div', { className: 'bt-wg-roster-head' }, t('Requests for you')),
    requests.map(cardFor),
    active.length === 0 ? null : h('div', { className: 'bt-wg-roster-head' }, t('Your tasks')),
    active.map(runningFor),
    note === null ? null : h('div', { className: 'bt-wg-note', role: 'status' }, note))
}
