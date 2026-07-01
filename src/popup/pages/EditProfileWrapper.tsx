import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { EditProfile as EditProfilePage } from './EditProfile';

export function EditProfileWrapper() {
  const navigate = useNavigate();
  const { publicKey, myProfile, setMyProfile } = useAuth();

  return (
    <EditProfilePage
      publicKey={publicKey}
      profile={myProfile}
      onSaved={(p) => setMyProfile(p)}
      onBack={() => navigate(-1)}
    />
  );
}
