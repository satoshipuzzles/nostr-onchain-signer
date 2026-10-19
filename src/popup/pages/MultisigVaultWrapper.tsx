import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MultisigVault as MultisigVaultPage } from './MultisigVault';

export function MultisigVaultWrapper() {
  const navigate = useNavigate();
  const { publicKey, setSelectedMultisigWallet } = useAuth();

  return (
    <MultisigVaultPage
      publicKey={publicKey}
      onCreateNew={() => navigate('/wallets/create')}
      onRequestSignature={(wallet, chain) => {
        setSelectedMultisigWallet(wallet);
        navigate(`/wallets/sign?chain=${chain}`);
      }}
      onBack={() => navigate(-1)}
    />
  );
}
