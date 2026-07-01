import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SendTx as SendTxPage } from './SendTx';

export function SendTxWrapper() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();

  return <SendTxPage publicKey={publicKey} onBack={() => navigate(-1)} />;
}
