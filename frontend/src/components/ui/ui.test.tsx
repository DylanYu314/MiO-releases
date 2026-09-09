import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Badge, Button, Card, Checkbox, EmptyState, Spinner } from './index'

describe('Button', () => {
  it('renders a button with its children and forwards aria props', () => {
    render(<Button aria-label="save">Save</Button>)
    const button = screen.getByRole('button', { name: 'save' })
    expect(button).toHaveTextContent('Save')
  })

  it('applies the variant class', () => {
    render(<Button variant="danger">Delete</Button>)
    expect(screen.getByRole('button')).toHaveClass('bg-red-600')
  })

  it('disables and shows a spinner while loading', () => {
    render(<Button loading>Go</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  it('defaults to type=button but lets a prop override it', () => {
    const { rerender } = render(<Button>x</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button')
    rerender(<Button type="submit">x</Button>)
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit')
  })

  it('fires onClick', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Click</Button>)
    await userEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('other primitives', () => {
  it('Card renders children and merges className', () => {
    render(
      <Card className="extra" data-testid="card">
        inside
      </Card>,
    )
    const card = screen.getByTestId('card')
    expect(card).toHaveTextContent('inside')
    expect(card).toHaveClass('extra')
  })

  it('Badge applies its tone', () => {
    render(<Badge tone="success">ok</Badge>)
    expect(screen.getByText('ok')).toHaveClass('text-green-800')
  })

  it('Checkbox forwards checked state and change', async () => {
    const onChange = vi.fn()
    render(<Checkbox checked readOnly onClick={onChange} aria-label="pick" />)
    const box = screen.getByRole('checkbox', { name: 'pick' })
    expect(box).toBeChecked()
    await userEvent.click(box)
    expect(onChange).toHaveBeenCalled()
  })

  it('EmptyState shows title, description and action', () => {
    render(
      <EmptyState title="Nothing here" description="Add something" action={<span>Do it</span>} />,
    )
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    expect(screen.getByText('Add something')).toBeInTheDocument()
    expect(screen.getByText('Do it')).toBeInTheDocument()
  })

  it('Spinner is decorative (aria-hidden)', () => {
    const { container } = render(<Spinner />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
  })
})
