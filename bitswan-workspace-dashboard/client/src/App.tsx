import { AuthGate } from './Auth';
import { Terminal } from './Terminal';

export function App() {
  return (
    <AuthGate>
      <div className="app">
        <div className="app__header">bitswan-workspace-dashboard · /workspace/workspace</div>
        <div className="app__terminal">
          <Terminal />
        </div>
      </div>
    </AuthGate>
  );
}
