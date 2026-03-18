// App.jsx — entrada principal do painel
// A URL do backend vem da variável de ambiente VITE_BACKEND_URL
// Configure em: Vercel → Settings → Environment Variables
//   VITE_BACKEND_URL = https://seu-backend.onrender.com

import PainelPedidos from "./PainelPedidos.jsx";

export default function App() {
  return <PainelPedidos />;
}
