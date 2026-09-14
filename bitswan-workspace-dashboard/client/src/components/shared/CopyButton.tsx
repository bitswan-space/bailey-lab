import { useEffect, useRef, useState } from 'react';
import { Check, Clipboard } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/lib/notify';

interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  successToast?: string;
  className?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
}

export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  successToast = 'Copied to clipboard',
  className,
  size = 'sm',
  variant = 'outline',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      toast.error('Copy failed — clipboard unavailable');
      return;
    }
    toast.success(successToast);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button type="button" size={size} variant={variant} className={className} onClick={() => void copy()}>
      {copied ? (
        <Check className="size-3.5 text-primary" aria-hidden />
      ) : (
        <Clipboard className="size-3.5" aria-hidden />
      )}
      {copied ? copiedLabel : label}
    </Button>
  );
}
