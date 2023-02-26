import {NextPage} from 'next';
import {Stack} from '@mui/system';
import ListHeader from '../../components/ListHeader';
import React, {useEffect, useRef, useState} from 'react';
import LoadingMessage from '../../components/LoadingMessage';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle, Table, TableBody,
  TableCell, TableContainer,
  TableHead,
  TableRow,
  TextField, Typography
} from '@mui/material';
import { StackItem } from '../../components/StackItem';
import {NamespaceDto} from 'objectified-data/dist/src/dto/namespace.dto';
import axios from 'axios';
import {alertDialog, confirmDialog} from '../../components/dialogs/ConfirmDialog';
import Paper from '@mui/material/Paper';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(true);
  const [addNamespaceShowing, setAddNamespaceShowing] = useState(false);
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
      return alertDialog('Namespace is missing a value.');
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
          <Button onClick={() => addNamespace()}>Add</Button>
          <Button onClick={() => setAddNamespaceShowing(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      <Stack direction={'row'}>
        <ListHeader header={'Namespaces'} onAdd={addNamespaceClicked}/>
      </Stack>

      <TableContainer component={Paper}>
        <Table sx={{ minWidth: 650 }} aria-label={'namespace table'}>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Name</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Enabled</TableCell>
              <TableCell>Create Date</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {namespaces.map((row) => (
              <>
                <TableRow>
                  <TableCell>{row.id}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.description}</TableCell>
                  <TableCell>{row.enabled ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{row.create_date}</TableCell>
                </TableRow>
              </>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </>
  );
}

export default Namespaces;
