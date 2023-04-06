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
    DialogTitle, FormControl, InputLabel, Select, SelectChangeEvent, Table, TableBody,
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
import MenuItem from "@mui/material/MenuItem";
import {loadClasses} from "../../components/data/classes";
import {loadProperties} from "../../components/data/properties";

const ClassProperties: NextPage = () => {
    const [properties, setProperties] = useState([]);
    const [classes, setClasses] = useState([]);
    const [loading, setLoading] = useState(false);
    const [addFormShowing, setAddFormShowing] = useState(false);
    const [classId, setClassId] = useState(0);
    const [propertyId, setPropertyId] = useState(0);

    const reloadProperties = () => {
        setLoading(true);
        loadProperties(setProperties)
          .then(() => setLoading(false));
    }

    const reloadClasses = () => {
        setLoading(true);
        loadClasses(setClasses)
          .then(() => setLoading(false));
    }

    const reloadClassProperties = () => {
        setLoading(true);
        setLoading(false);
    }

    const addClassPropertyClicked = () => {
        if (classId === 0) {
            return errorDialog('Please select a class.');
        }

        if (propertyId === 0) {
            return errorDialog('Please select a property to assign to the selected class.');
        }

        axios.put(`/app/class-properties/add/${classId}/${propertyId}`)
          .then((x) => {
              setAddFormShowing(false);
              reloadClassProperties();
          })
          .catch((x) => {
              errorDialog(x.message);
          });
    }

    const classesList = () => {
        if (classes.length === 0) {
            return (
              <>
                  <Stack direction={'row'}>
                      <StackItem sx={{width: '100%', padding: '1em', color: '#000'}}>
                          <Typography fontWeight={'bold'}>No classes have been defined yet.</Typography>
                      </StackItem>
                  </Stack>
              </>
            );
        }

        return (
          <TableContainer component={Box}>
              <Table sx={{minWidth: 650, backgroundColor: '#fff'}} aria-label={'namespace table'}>
                  <TableHead>
                      <TableRow>
                          <TableCell sx={{fontWeight: 'bold'}}>ID</TableCell>
                          <TableCell sx={{fontWeight: 'bold'}}>Name</TableCell>
                          <TableCell sx={{fontWeight: 'bold'}}>Description</TableCell>
                          <TableCell sx={{fontWeight: 'bold', textAlign: 'center'}}>Enabled</TableCell>
                          <TableCell sx={{fontWeight: 'bold'}}>Create Date</TableCell>
                          <TableCell/>
                      </TableRow>
                  </TableHead>
                  <TableBody>
                      {classes.map((row) => (
                        <>
                            <TableRow hover>
                                <TableCell>{row.id}</TableCell>
                                <TableCell>{row.name}</TableCell>
                                <TableCell>{row.description}</TableCell>
                                <TableCell sx={{textAlign: 'center'}}>{row.enabled ? <CheckBox/> :
                                  <CheckBoxOutlineBlank/>}</TableCell>
                                <TableCell>{row.create_date}</TableCell>
                                <TableCell align={'right'}><EditOutlined/> <Delete sx={{color: 'red'}}/></TableCell>
                            </TableRow>
                        </>
                      ))}
                  </TableBody>
              </Table>
          </TableContainer>
        );
    }

    const handleClassIdChanged = (event: SelectChangeEvent) => setClassId(event.target.value as number);
    const handlePropertyIdChanged = (event: SelectChangeEvent) => setPropertyId(event.target.value as number);

    useEffect(() => {
        reloadProperties();
        reloadClasses();
    }, []);

    if (loading) {
        return (
          <LoadingMessage label={'Retrieving class and property list, one moment ...'}/>
        );
    }

    return (
      <>
          <div sx={{width: '100%'}} style={{border: '1px solid #ddd', backgroundColor: '#fff'}}>
              <Dialog open={addFormShowing}>
                  <DialogTitle>Class Property</DialogTitle>
                  <DialogContent>
                      <Stack direction={'column'} sx={{padding: '1em'}}>
                          <StackItem sx={{width: '100%', padding: '4px'}}>
                              <FormControl fullWidth required>
                                  <InputLabel id={'class-label'} required>Class Name</InputLabel>
                                  <Select labelId={'class-label'} id={'class_id'} label={'Class Name'}
                                          onChange={handleClassIdChanged}
                                          value={classId}>
                                      {classes.map((x) => (
                                        <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                                      ))}
                                  </Select>
                              </FormControl>
                          </StackItem>

                          <StackItem sx={{width: '100%', padding: '4px'}}>
                              <FormControl fullWidth required>
                                  <InputLabel id={'property-label'} required>Property</InputLabel>
                                  <Select labelId={'property-label'} id={'property_id'} label={'Property'}
                                          onChange={handlePropertyIdChanged}
                                          value={propertyId}>
                                      {properties.map((x) => (
                                        <MenuItem value={x.id}>{x.name} ({x.description})</MenuItem>
                                      ))}
                                  </Select>
                              </FormControl>
                          </StackItem>
                      </Stack>
                  </DialogContent>
                  <DialogActions>
                      <Button onClick={() => addClassPropertyClicked()} variant={'contained'}>Add</Button>
                      <Button onClick={() => setAddFormShowing(false)} variant={'contained'}
                              color={'error'}>Cancel</Button>
                  </DialogActions>
              </Dialog>

              <Stack direction={'row'}>
                  <StackItem sx={{width: '100%', textAlign: 'left', backgroundColor: '#ddd'}}>
                      <Typography fontWeight={'bold'} sx={{color: 'black', verticalAlign: 'middle', padding: '1em'}}>
                          Class Properties
                      </Typography>
                  </StackItem>
              </Stack>

              <Stack direction={'row'}>
                  <StackItem sx={{width: '100%', padding: '1em', color: '#000'}}>
                      <Typography>
                          Class Properties are used to define the names and field types of data that can be stored
                          in an instance of a Class.
                      </Typography>
                  </StackItem>
                  <StackItem sx={{textAlign: 'right', padding: '1em', width: '10%'}}>
                      <Button onClick={() => setAddFormShowing(true)} variant={'outlined'}>Add</Button>
                  </StackItem>
              </Stack>

              {classesList()}
          </div>
      </>
    );
}

export default ClassProperties;
