import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MultiSig as MultiSigPage } from './MultiSig';

export function MultiSigWrapper() {
  const navigate = useNavigate();
  const { publicKey, following } = useAuth();

  return (
    <MultiSigPage
      publicKey={publicKey}
      followingPubkeys={following}
      onBack={() => navigate(-1)}
      onCreated={() => navigate('/wallets')}
    />
  );
}
