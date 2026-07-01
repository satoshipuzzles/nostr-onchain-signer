import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { SigningInbox } from './SigningInbox';

export function SigningInboxWrapper() {
  const navigate = useNavigate();
  const { publicKey } = useAuth();

  return <SigningInbox publicKey={publicKey} onBack={() => navigate(-1)} />;
}
