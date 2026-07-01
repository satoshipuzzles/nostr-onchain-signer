import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WalletView as WalletViewPage } from './WalletView';

export function WalletViewWrapper() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();

  return <WalletViewPage publicKey={publicKey} onBack={() => navigate(-1)} />;
}
