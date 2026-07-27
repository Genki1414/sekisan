import { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import { startLineLogin, completeLineLoginIfNeeded, signOut } from "./lib/lineAuth";

export default function AuthBar() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        await completeLineLoginIfNeeded();
      } catch (e) {
        if (mounted) setError(e.message);
      }
      const { data } = await supabase.auth.getSession();
      if (mounted) {
        setUser(data.session?.user ?? null);
        setLoading(false);
      }
    })();

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  if (loading) return null;

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
