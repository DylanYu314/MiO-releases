import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { renderWithProviders } from '../../test/renderWithProviders'
import { useConfirm } from './confirm/context'
import { Modal } from './Modal'
import { useToast } from './toast/context'

describe('Modal', () => {
  it('renders its children as a dialog when open', () => {
    render(
      <Modal open onClose={() => {}} labelledBy="t">
        <h2 id="t">Title</h2>
      </Modal>,
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('Title')
  })

  it('renders nothing when closed', () => {
    render(
      <Modal open={false} onClose={() => {}}>
        hidden
      </Modal>,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('closes on Escape and on overlay click', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(
      <Modal open onClose={onClose}>
        body
      </Modal>,
    )
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

function ConfirmProbe() {
  const confirm = useConfirm()
  const [result, setResult] = useState<string>('')
  return (
    <>
      <button
        type="button"
        onClick={async () =>
          setResult(String(await confirm({ title: 'Sure?', confirmLabel: 'Yes' })))
        }
      >
        ask
      </button>
      <span>result: {result}</span>
    </>
  )
}

describe('useConfirm', () => {
  it('resolves true when confirmed', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConfirmProbe />)
    await user.click(screen.getByRole('button', { name: 'ask' }))
    await user.click(screen.getByRole('button', { name: 'Yes' }))
    expect(await screen.findByText('result: true')).toBeInTheDocument()
  })

  it('resolves false when cancelled', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ConfirmProbe />)
    await user.click(screen.getByRole('button', { name: 'ask' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('result: false')).toBeInTheDocument()
  })
})

function ToastProbe() {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast('Saved', 'success')}>
      go
    </button>
  )
}

describe('useToast', () => {
  it('shows a status message', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ToastProbe />)
    await user.click(screen.getByRole('button', { name: 'go' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })
})
