import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RelaySettings as RelaySettingsPage } from './RelaySettings';

export function RelaySettingsWrapper() {
  const navigate = useNavigate();

  return <RelaySettingsPage onBack={() => navigate(-1)} />;
}
