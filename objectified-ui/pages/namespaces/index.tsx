import {NextPage} from 'next';
import {Box, Stack} from '@mui/system';
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
import {alertDialog, confirmDialog, errorDialog} from '../../components/dialogs/ConfirmDialog';
import Paper from '@mui/material/Paper';
import {CheckBox, CheckBoxOutlineBlank, Delete, DeleteOutline, Edit, EditOutlined} from '@mui/icons-material';

const Namespaces: NextPage = () => {
  const [namespaces, setNamespaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addNamespaceShowing, setAddNamespaceShowing] = useState(false);
  const namespaceRef = useRef<HTMLInputElement>();

  const addNamespaceClicked = () => setAddNamespaceShowing(true);

  const reloadNamespaces = () => {
    setLoading(true);
    axios.get('/app/namespaces/list')
      .then((result) => {
        setNamespaces(result.data);
        setLoading(false);
      });
  }

  const addNamespace = () => {
    const namespaceValue = namespaceRef?.current?.value ?? '';

    if (namespaceValue.length > 0) {
      const namespace: any = {};

      namespace.name = namespaceValue;
      namespace.description = namespaceValue;
      namespace.enabled = true;

      axios.post('/app/namespaces/create', namespace)
        .then((x) => {
          setAddNamespaceShowing(false);
          reloadNamespaces();
        })
        .catch((x) => {
          errorDialog(x.message);
        });
    } else {
      return errorDialog('Namespace is missing a value.');
    }
  }

  const namespaceList = () => {
    if (namespaces.length === 0) {
      return (
        <>
          <Stack direction={'row'}>
            <StackItem sx={{ width: '100%', padding: '1em', color: '#000' }}>
              <Typography fontWeight={ 'bold' }>No namespaces have been defined yet.  You will not be able to define
              any objects until you create a namespace to group them with.</Typography>
            </StackItem>
          </Stack>
        </>
      );
    }

    return (
      <TableContainer component={Box}>
        <Table sx={{ minWidth: 650, backgroundColor: '#fff' }} aria-label={'namespace table'}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 'bold' }}>ID</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Name</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Description</TableCell>
              <TableCell sx={{ fontWeight: 'bold', textAlign: 'center' }}>Enabled</TableCell>
              <TableCell sx={{ fontWeight: 'bold' }}>Create Date</TableCell>
              <TableCell/>
            </TableRow>
          </TableHead>
          <TableBody>
            {namespaces.map((row) => (
              <>
                <TableRow hover>
                  <TableCell>{row.id}</TableCell>
                  <TableCell>{row.name}</TableCell>
                  <TableCell>{row.description}</TableCell>
                  <TableCell sx={{ textAlign: 'center' }}>{row.enabled ? <CheckBox/> : <CheckBoxOutlineBlank/>}</TableCell>
                  <TableCell>{row.create_date}</TableCell>
                  <TableCell align={'right'}><EditOutlined/> <Delete sx={{ color: 'red' }}/></TableCell>
                </TableRow>
              </>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    );
  }

  useEffect(() => reloadNamespaces(), []);

  if (loading) {
    return (
      <LoadingMessage label={'Retrieving namespace list, one moment ...'} />
    );
  }

  return (
    <>
      <div sx={{ width: '100%' }} style={{ border: '1px solid #ddd', backgroundColor: '#fff' }}>
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
            <Button onClick={() => addNamespace()} variant={'contained'}>Add</Button>
            <Button onClick={() => setAddNamespaceShowing(false)} variant={'contained'} color={'error'}>Cancel</Button>
          </DialogActions>
        </Dialog>

        <Stack direction={'row'} sx={{ padding: '1em' }}>
          <StackItem sx={{ width: '100%', textAlign: 'left', backgroundColor: '#ddd' }}>
            <Typography fontWeight={'bold'} sx={{ color: 'black', verticalAlign: 'middle', padding: '1em' }}>
              Namespaces
            </Typography>
          </StackItem>
        </Stack>

        <Stack direction={'row'} sx={{ padding: '1em' }}>
          <StackItem sx={{ width: '90%', padding: '1em', color: '#000' }}>
            <Typography>
              Namespaces are logical groupings of classes, objects, and definitions, grouped by a unique identifier.
            </Typography>
          </StackItem>
          <StackItem sx={{ textAlign: 'right', padding: '1em', width: '10%' }}>
            <Button onClick={() => addNamespaceClicked()} variant={'outlined'}>Add</Button>
          </StackItem>
        </Stack>

        {namespaceList()}
      </div>
    </>
  );
}

export default Namespaces;
