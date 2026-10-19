import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RequestSignature as RequestSignaturePage } from './RequestSignature';
import { multisigChain } from '@/lib/bitcoin/wallet-store';
import { isChain } from '@/lib/bitcoin/chain';

export function RequestSignatureWrapper() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { publicKey, selectedMultisigWallet } = useAuth();

  if (!selectedMultisigWallet) {
    navigate('/wallets');
    return null;
  }

  return (
    <RequestSignaturePage
      wallet={selectedMultisigWallet}
      publicKey={publicKey}
      onDone={() => navigate('/wallets')}
      onBack={() => navigate(-1)}
      initialRecipient={searchParams.get('to') || undefined}
      initialAmount={searchParams.get('amount') || undefined}
      initialMemo={searchParams.get('memo') || undefined}
      // ?chain= when the vault page chose one, else the vault's own chain
      initialChain={(() => { const c = searchParams.get('chain'); return isChain(c) ? c : multisigChain(selectedMultisigWallet); })()}
    />
  );
}
