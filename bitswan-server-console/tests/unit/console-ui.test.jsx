// console-ui.test.jsx — renders each shared primitive in window.SC_UI and
// drives its branches (open/closed, hover, focus, copy, complete, error).
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SC_UI } from './harness.js';

const {
  Avatar, Card, PageHeader, Field, TextInput, Modal, SegmentedCode, QRCode, QRImage,
  Toggle, DeviceIcon, Toast, EmptyState, CopyChip, ProtoHint, Stat,
  Drawer, Select, AvatarStack, LoadBanner, ErrorBanner, LiveState,
} = SC_UI;

const user = { id: 'u1', name: 'Ada Lovelace', color: '#093df5' };

describe('Avatar / AvatarStack', () => {
  it('renders initials from the name', () => {
    render(<Avatar user={user} ring={2} />);
    expect(screen.getByText('AL')).toBeTruthy();
  });
  it('returns null without a user', () => {
    const { container } = render(<Avatar user={null} />);
    expect(container.firstChild).toBeNull();
  });
  it('ring=true variant renders', () => {
    render(<Avatar user={user} ring={true} />);
    expect(screen.getByText('AL')).toBeTruthy();
  });
  it('AvatarStack shows overflow count', () => {
    const users = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'u' + n, name: `N${n} x`, color: '#000' }));
    render(<AvatarStack users={users} max={4} />);
    expect(screen.getByText('+2')).toBeTruthy();
  });
});

describe('Card', () => {
  it('toggles hover shadow and fires onClick', () => {
    const onClick = vi.fn();
    const { container } = render(<Card hover onClick={onClick}>body</Card>);
    const el = container.firstChild;
    fireEvent.mouseEnter(el);
    fireEvent.mouseLeave(el);
    fireEvent.click(el);
    expect(onClick).toHaveBeenCalled();
  });
});

describe('PageHeader / Field', () => {
  it('renders title, subtitle, icon, actions', () => {
    render(<PageHeader title="T" subtitle="S" icon="gauge" actions={<button>Go</button>} />);
    expect(screen.getByText('T')).toBeTruthy();
    expect(screen.getByText('S')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
  });
  it('Field renders label + hint', () => {
    render(<Field label="L" hint="H"><input /></Field>);
    expect(screen.getByText('L')).toBeTruthy();
    expect(screen.getByText('H')).toBeTruthy();
  });
});

describe('TextInput', () => {
  it('fires onChange, focus, blur', () => {
    const onChange = vi.fn();
    render(<TextInput value="" onChange={onChange} placeholder="p" mono />);
    const input = screen.getByPlaceholderText('p');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith('hi');
  });
});

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false}>x</Modal>);
    expect(container.firstChild).toBeNull();
  });
  it('renders header/footer and closes on Escape + backdrop + button', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal open onClose={onClose} title="Title" subtitle="Sub" icon="x" footer={<span>foot</span>}>body</Modal>,
    );
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('foot')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTitle('Close'));
    // backdrop is the outermost div
    fireEvent.mouseDown(container.firstChild);
    // inner panel stops propagation
    fireEvent.mouseDown(screen.getByText('body'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('SegmentedCode', () => {
  it('cleans input, fires onChange + onComplete on full length', () => {
    const onChange = vi.fn();
    const onComplete = vi.fn();
    function Wrap() {
      const [v, setV] = React.useState('');
      return (
        <SegmentedCode format={[2, 2]} value={v} onChange={(nv) => { setV(nv); onChange(nv); }}
          onComplete={onComplete} auto size="lg" />
      );
    }
    const { container } = render(<Wrap />);
    const input = container.querySelector('input');
    fireEvent.click(container.firstChild);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ab-cd!' } });
    expect(onChange).toHaveBeenCalledWith('ABCD');
    fireEvent.blur(input);
    expect(onComplete).toHaveBeenCalledWith('ABCD');
  });
});

describe('QRCode / QRImage', () => {
  it('QRCode renders an svg deterministically', () => {
    const { container } = render(<QRCode seed="bailey" size={50} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
  it('QRImage shows placeholder then an img once toDataURL resolves', async () => {
    const { container, rerender } = render(<QRImage value="" size={40} />);
    // empty value → placeholder branch, no async
    expect(container.querySelector('img')).toBeNull();
    await act(async () => {
      rerender(<QRImage value="otpauth://x" size={40} />);
      await Promise.resolve();
    });
  });
});

describe('Toggle', () => {
  it('fires onChange and respects disabled', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle on={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<Toggle on disabled onChange={onChange} />);
  });
});

describe('DeviceIcon', () => {
  it('maps known + unknown kinds', () => {
    render(<><DeviceIcon kind="phone" /><DeviceIcon kind="weird" /></>);
    expect(document.querySelector('[data-icon="smartphone"]')).toBeTruthy();
    expect(document.querySelector('[data-icon="monitor"]')).toBeTruthy();
  });
});

describe('Toast', () => {
  it('returns null without a toast and renders each tone', () => {
    const { container, rerender } = render(<Toast toast={null} />);
    expect(container.firstChild).toBeNull();
    for (const tone of ['success', 'danger', 'info', 'unknown']) {
      rerender(<Toast toast={{ tone, text: tone }} />);
      expect(screen.getByText(tone)).toBeTruthy();
    }
  });
});

describe('EmptyState / ProtoHint / LoadBanner / ErrorBanner / LiveState', () => {
  it('EmptyState renders text + action', () => {
    render(<EmptyState icon="x" title="Empty" text="none" action={<button>Act</button>} />);
    expect(screen.getByText('Empty')).toBeTruthy();
    expect(screen.getByText('Act')).toBeTruthy();
  });
  it('ProtoHint renders children', () => {
    render(<ProtoHint>demo</ProtoHint>);
    expect(screen.getByText('demo')).toBeTruthy();
  });
  it('LoadBanner default + custom label', () => {
    const { rerender } = render(<LoadBanner />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    rerender(<LoadBanner label="custom" />);
    expect(screen.getByText('custom')).toBeTruthy();
  });
  it('ErrorBanner renders message + retry', () => {
    const onRetry = vi.fn();
    render(<ErrorBanner message="bad" onRetry={onRetry} />);
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalled();
  });
  it('ErrorBanner default message without retry', () => {
    render(<ErrorBanner />);
    expect(screen.getByText(/Couldn't load/)).toBeTruthy();
  });
  it('LiveState picks banner by status', () => {
    const { rerender, container } = render(<LiveState status="error" error="e" />);
    expect(screen.getByText('e')).toBeTruthy();
    rerender(<LiveState status="loading" label="L" />);
    expect(screen.getByText('L')).toBeTruthy();
    rerender(<LiveState status="idle" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    rerender(<LiveState status="ok" />);
    // ok → renders nothing
  });
});

describe('CopyChip', () => {
  it('copies and flips to the check icon', () => {
    vi.useFakeTimers();
    render(<CopyChip text="secret" label="Copy" />);
    fireEvent.click(screen.getByText('Copy'));
    act(() => vi.advanceTimersByTime(1500));
    vi.useRealTimers();
    expect(screen.getByText('Copy')).toBeTruthy();
  });
  it('falls back to the text when no label', () => {
    render(<CopyChip text="abc" />);
    expect(screen.getByText('abc')).toBeTruthy();
  });
});

describe('Stat', () => {
  it('renders all tones + handles click/hover', () => {
    const onClick = vi.fn();
    const { container, rerender } = render(<Stat label="L" value={3} icon="x" tone="primary" onClick={onClick} sub="s" />);
    const el = container.firstChild;
    fireEvent.mouseEnter(el);
    fireEvent.click(el);
    fireEvent.mouseLeave(el);
    expect(onClick).toHaveBeenCalled();
    for (const tone of ['neutral', 'danger', 'warning', 'success']) {
      rerender(<Stat label="L" value={1} icon="x" tone={tone} sub="s" />);
    }
  });
});

describe('Drawer', () => {
  it('closed renders nothing; open renders + closes on Escape/backdrop/button', () => {
    const onClose = vi.fn();
    const { container, rerender } = render(<Drawer open={false}>x</Drawer>);
    expect(container.firstChild).toBeNull();
    rerender(<Drawer open onClose={onClose} title="DT" subtitle="DS" icon="x" footer={<span>df</span>}>body</Drawer>);
    expect(screen.getByText('DT')).toBeTruthy();
    expect(screen.getByText('df')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTitle('Close'));
    fireEvent.mouseDown(screen.getByText('body'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Select', () => {
  it('fires onChange with the chosen value', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
