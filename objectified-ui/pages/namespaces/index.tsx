import {NextPage} from 'next';
import {Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import {useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(true);

  const addNamespaceClicked = () => {
    console.log('Namespace clicked.');
  }

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving namespace list, one moment ...'} />
    );
  }

  return (
    <>
      <Stack direction={'row'}>
        <ListHeader header={'Namespaces'} onAdd={addNamespaceClicked}/>
      </Stack>
      {namespaces}
    </>
  );
}

export default Namespaces;
