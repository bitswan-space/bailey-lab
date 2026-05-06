import { AuthGate } from './Auth';
import { Terminal } from './Terminal';

export function App() {
  return (
    <AuthGate>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="border-b border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground">
          bitswan-workspace-dashboard · /workspace/workspace
        </header>
        <main className="min-h-0 flex-1 bg-white p-1">
          <Terminal />
        </main>
      </div>
    </AuthGate>
  );
}
