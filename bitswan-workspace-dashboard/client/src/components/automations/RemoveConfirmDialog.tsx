import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface RemoveTarget {
  deploymentId: string;
  name: string;
  stageLabel: string;
}

interface RemoveConfirmDialogProps {
  target: RemoveTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirm prompt for the destructive Remove action. Shared between the
 * Deployments and Worktree views because the wording / wiring is identical;
 * the parent owns the `target` state and the actual remove call.
 */
export function RemoveConfirmDialog({
  target,
  onCancel,
  onConfirm,
}: RemoveConfirmDialogProps) {
  return (
    <AlertDialog open={target !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove deployment?</AlertDialogTitle>
          <AlertDialogDescription>
            {target
              ? `This stops the container and removes "${target.name}" (${target.stageLabel}) from bitswan.yaml. The source files on disk are kept; you can deploy again later.`
              : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
