import {LinearProgress, Typography} from '@mui/material';
import {NextPage} from 'next';
import {Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import {useState} from 'react';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(true);

  const addNamespaceClicked = () => {
    console.log('Namespace clicked.');
  }

  if (loading) {
    return (
      <>
        <Typography>
          Retrieving namespace list, one moment ...
        </Typography>
        <p/>
        <LinearProgress/>
      </>
    )
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
