import React from "react";
import ReactDOM from "react-dom/client";
import AshiBaseSekisan from "./AshiBaseSekisan.jsx";
import AuthBar from "./AuthBar.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthBar />
    <AshiBaseSekisan />
  </React.StrictMode>
);
