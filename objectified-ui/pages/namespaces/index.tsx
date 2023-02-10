import {NextPage} from 'next';
import {Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import {useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {Button, Dialog, DialogActions, DialogContent, DialogTitle, TextField} from '@mui/material';
import { StackItem } from '../../components/StackItem';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addNamespaceShowing, setAddNamespaceShowing] = useState(false);
  const [errorState, setErrorState] = useState<[boolean, string]>([false, '']);
  const namespaceRef = useRef();

  const addNamespaceClicked = () => setAddNamespaceShowing(true);

  const addNamespace = () => {
    const namespaceValue = namespaceRef?.current?.value ?? '';

    if (namespaceValue.length > 0) {
      console.log(`Add namespace: ${namespaceValue}`);
      setAddNamespaceShowing(false);
    } else {
      setErrorState([true, 'Namespace is missing a value.']);
    }
  }

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
      {namespaces}
    </>
  );
}

export default Namespaces;
