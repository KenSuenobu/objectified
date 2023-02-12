import {NextPage} from 'next';
import {Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import {NamespaceDto} from 'objectified-data/dist/src/dto/namespace.dto';
import axios from 'axios';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(true);
  const [addNamespaceShowing, setAddNamespaceShowing] = useState(false);
  const [errorState, setErrorState] = useState<[boolean, string]>([false, '']);
  const namespaceRef = useRef<HTMLInputElement>();

  const addNamespaceClicked = () => setAddNamespaceShowing(true);

  const addNamespace = () => {
    const namespaceValue = namespaceRef?.current?.value ?? '';

    if (namespaceValue.length > 0) {
      const namespace: any = {};

      namespace.name = namespaceValue;
      namespace.description = namespaceValue;
      namespace.enabled = true;

      axios.post('/app/namespaces/create', namespace)
        .then((x) => {
          setNeedsRefresh(true);
          setAddNamespaceShowing(false);
        });
    } else {
      setErrorState([true, 'Namespace is missing a value.']);
    }
  }

  useEffect(() => {
    axios.get('/app/namespaces/list')
      .then((result) => {
        setNamespaces(result.data);
        setLoading(false);
      });
  }, [needsRefresh]);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving namespace list, one moment ...'} />
    );
  }

  return (
    <>
      <Dialog open={errorState[0]}>
        <DialogTitle>Error</DialogTitle>
        <DialogContent>
          <Stack direction={'row'}>
            {errorState[1]}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setErrorState([false, errorState[1]])}>Cancel</Button>
        </DialogActions>
      </Dialog>
      <Dialog open={addNamespaceShowing}>
        <DialogTitle>Namespace</DialogTitle>
        <DialogContent>
          <Stack direction={'row'}>
            <StackItem sx={{ width: '100%' }}>
              <TextField id={'namespace'} label={'Namespace'} variant={'outlined'} required inputRef={namespaceRef}/>
            </StackItem>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={addNamespace}>Add</Button>
          <Button onClick={() => setAddNamespaceShowing(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>
      <Stack direction={'row'}>
        <ListHeader header={'Namespaces'} onAdd={addNamespaceClicked}/>
      </Stack>
      {JSON.stringify(namespaces, null, 2)}
    </>
  );
}

export default Namespaces;
