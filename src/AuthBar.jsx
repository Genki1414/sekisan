import { useEffect, useState } from "react";
import { useSession } from "./lib/useSession";
import { startLineLogin, completeLineLoginIfNeeded, signOut } from "./lib/lineAuth";

export default function AuthBar() {
  const session = useSession();
  const [error, setError] = useState(null);

  useEffect(() => {
    completeLineLoginIfNeeded().catch((e) => setError(e.message));
  }, []);

  if (session === undefined) return null;

  const user = session?.user ?? null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        fontSize: 13,
        background: "#f5f5f5",
        borderBottom: "1px solid #ddd",
      }}
    >
      {error && <span style={{ color: "crimson" }}>ログインエラー: {error}</span>}
      {user ? (
        <>
          <span>{user.user_metadata?.name ?? user.email} でログイン中</span>
          <button onClick={signOut}>ログアウト</button>
        </>
      ) : (
        <button onClick={startLineLogin}>LINEでログイン（見積書PDF機能を使う場合）</button>
      )}
    </div>
  );
}
